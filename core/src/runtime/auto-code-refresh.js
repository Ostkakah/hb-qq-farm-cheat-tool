const { createScheduler } = require('../services/scheduler');
const wxLoginAdapter = require('../services/wx-login-adapter');

/**
 * 账号被手机端登录踢下线后的重登退避时间（分钟）。
 * 服务端对同一 GID 只保留最新会话：用户在手机上打开农场小程序，
 * 机器人的 WebSocket 会收到 KickoutNotify（原因「已在其他终端登录」）并被踢。
 * 反过来机器人在此期间重登，也会把用户手机上的会话顶掉。
 *
 * 默认 5 分钟：被顶号后尽快恢复自动化，避免农场长时间无人看管。
 * 代价是用户此刻正在手机端玩的话，机器人重登会把手机也顶掉。
 * 想安静玩一会儿，请把该账号点「停止」进入 30 分钟暂停（期间机器人完全不登录）。
 *
 * 可用环境变量 FARM_KICKOUT_RELOGIN_DELAY_MIN 覆盖（分钟）。
 */
const KICKOUT_RELOGIN_DELAY_MIN = Math.max(
    1,
    Number.parseInt(process.env.FARM_KICKOUT_RELOGIN_DELAY_MIN, 10) || 5,
);
const KICKOUT_RELOGIN_DELAY_MS = KICKOUT_RELOGIN_DELAY_MIN * 60 * 1000;

/**
 * 手动「停止」账号后的暂停时长：暂停期间机器人完全不碰这个号
 * （不刷 Code、不保活、不重登），到期后自动恢复自动化。
 */
const MANUAL_PAUSE_MS = 30 * 60 * 1000;

function createAutoCodeRefreshService(deps) {
  const {
    store,
    getAccounts,
    addOrUpdateAccount,
    resolveWorkerControls,
    log,
    addAccountLog,
  } = deps;

  const scheduler = createScheduler('auto_code_refresh');
  const recoveryState = new Map();
  const MAX_DAILY_RECOVERIES = 8;
  const MAX_CONSECUTIVE_FAILURES = 3;
  // 熔断后的降级重试间隔：不再彻底放弃，账号长期离线比多试几次糟糕得多。
  const DEGRADED_RELOGIN_DELAY_MS = 30 * 60 * 1000;
  // 换 Code 的网络请求最长等待时间。超时按失败处理并排退避重登，
  // 否则一次网络卡死就会让账号离线到进程重启。
  const credentialRefreshTimeoutMs = Math.max(
    1000,
    Number(deps.credentialRefreshTimeoutMs) || 90 * 1000,
  );

  function getRecoveryState(accountId) {
    const date = new Date().toISOString().slice(0, 10);
    const current = recoveryState.get(String(accountId));
    if (!current || current.date !== date) {
      const fresh = { date, attempts: 0, failures: 0 };
      recoveryState.set(String(accountId), fresh);
      return fresh;
    }
    return current;
  }

  function isRecoveryReason(reason) {
    return ['ws_400', 'kickout:', 'ws_reconnect_failed:', 'refresh_failed']
      .some(prefix => String(reason || '').includes(prefix));
  }

  function getTaskName(accountId) {
    return `refresh_${  String(accountId || '')}`;
  }

  function getKeepaliveTaskName(accountId) {
    return `wx_keepalive_${String(accountId || '')}`;
  }

  function getResumeTaskName(accountId) {
    return `resume_${String(accountId || '')}`;
  }

  function findAccount(accountId) {
    const data = getAccounts();
    const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
    return accounts.find(acc => String(acc.id) === String(accountId));
  }

  function normalizeConfig(accountId) {
    const cfg = store.getAutoCodeRefresh ? store.getAutoCodeRefresh(accountId) : null;
    return {
      enabled: cfg && cfg.enabled === true,
      intervalMinutes: Math.max(1, Math.min(1440, Number(cfg && cfg.intervalMinutes) || 60)),
    };
  }

  async function requestFarmCode(account) {
    const wxid = String(account && account.wxid || '').trim();
    if (!wxid) throw new Error('账号缺少 wxid，无法自动刷新 Code');

    if (!account.loginBuffer) throw new Error('账号缺少应用宝登录凭据，请重新扫码登录');
    if (account.refreshtoken) {
      const keepalive = await wxLoginAdapter.keepWxCredentialAlive(account);
      if (!keepalive.Success) throw new Error(keepalive.Message || '微信凭证续期失败');
    }
    const local = await wxLoginAdapter.getFarmCode(wxid, { accountId: account.id });
    if (local.Success && local.Data && local.Data.code) return String(local.Data.code);
    throw new Error(local.Message || '进程内获取 Code 失败');
  }

  /**
   * 刷新凭证必须带超时。
   *
   * 线上故障：换 Code 的网络请求（应用宝 / q.qq.com）卡住不返回，
   * promise 永远不 settle —— 于是既不重启 worker、也不排退避重登，
   * 账号会一直离线到进程重启为止。超时后按失败处理，交给上层排重登。
   */
  async function requestFarmCodeWithTimeout(account) {
    let timer = null;
    try {
      return await Promise.race([
        requestFarmCode(account),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('刷新凭证超时')), credentialRefreshTimeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
    }
    finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function refreshAccountCode(accountId, reason = 'timer') {
    const account = findAccount(accountId);
    if (!account) return false;
    if (account.platform !== 'wx') {
      // QQ 的手动/抓包/NapCat 扫码都不提供可复用的微信凭据，
      // 绝不能去调微信适配器，也不能消耗它的失败预算。
      addAccountLog('qq_code_required', 'QQ 账号需要重新获取 QQ Code，当前登录渠道不支持后台自动刷新',
        account.id, account.name, { reason });
      return false;
    }
    if (isRecoveryReason(reason) && !normalizeConfig(accountId).enabled) return false;

    const recovery = isRecoveryReason(reason) ? getRecoveryState(accountId) : null;
    // 熔断不再「永久放弃」：连续失败或当日次数用尽时降级成 30 分钟一次的重试，
    // 并重置计数。账号一直离线比多试几次糟糕得多，凭据问题则由失败日志暴露。
    if (recovery && (recovery.attempts >= MAX_DAILY_RECOVERIES
      || recovery.failures >= MAX_CONSECUTIVE_FAILURES)) {
      addAccountLog('auto_relogin_degraded',
        `自动恢复次数已达上限，${Math.round(DEGRADED_RELOGIN_DELAY_MS / 60000)} 分钟后重试`,
        account.id, account.name, { reason, ...recovery });
      recovery.attempts = 0;
      recovery.failures = 0;
    }
    if (recovery) recovery.attempts += 1;

    try {
      const code = await requestFarmCodeWithTimeout(account);
      const nextAccount = { ...account, code };
      addOrUpdateAccount(nextAccount);

      const controls = typeof resolveWorkerControls === 'function' ? (resolveWorkerControls() || {}) : {};
      if (typeof controls.restartWorker === 'function') controls.restartWorker(nextAccount);

      addAccountLog('auto_code_refresh', `自动刷新 Code 成功，已重启账号: ${  account.name}`,
        account.id, account.name, { reason });
      log('系统', `自动刷新 Code 成功: ${  account.name}`, {
        accountId: String(account.id),
        accountName: account.name,
      });
      if (recovery) {
        recovery.failures = 0;
        // 成功恢复不消耗当日配额：配额只用来限制「一直失败」的反复重试。
        // 否则一天掉线几次就把配额烧光，账号从此再也自动不回来。
        recovery.attempts = Math.max(0, recovery.attempts - 1);
      }
      return true;
    } catch (err) {
      if (recovery) recovery.failures += 1;
      addAccountLog('auto_code_refresh_failed', `自动刷新 Code 失败: ${  err.message}`,
        account.id, account.name, { reason });
      log('错误', `自动刷新 Code 失败: ${  account.name  } - ${  err.message}`, {
        accountId: String(account.id),
        accountName: account.name,
      });
      return false;
    }
  }

  function scheduleAccount(accountId) {
    const cfg = normalizeConfig(accountId);
    const taskName = getTaskName(accountId);
    scheduler.clear(taskName);
    scheduler.clear(getKeepaliveTaskName(accountId));

    const account = findAccount(accountId);
    // Code refresh and credential keepalive only apply to WeChat scan-login accounts.
    // All accounts are passed through rescheduleAll(), so QQ accounts must exit quietly.
    if (!account || account.platform !== 'wx') return;

    // 手动暂停中的账号：不挂任何定时任务，避免暂停期间被 Code 刷新重新拉起
    // （那会把正在用手机玩农场的用户顶下线）。
    if (isAccountPaused(accountId)) {
      log('系统', `自动刷新 Code 未启动: ${account.name} 处于暂停状态`, {
        accountId: String(accountId), accountName: account.name,
      });
      return;
    }

    if (!String(account.wxid || '').trim()) {
      log('系统', '自动刷新 Code 未启动: 账号缺少 wxid', {
        accountId: String(accountId),
        accountName: account.name || '',
      });
      return;
    }

    if (account.loginBuffer && account.refreshtoken) {
      scheduler.setIntervalTask(getKeepaliveTaskName(accountId), 30 * 60000, async () => {
        const latest = findAccount(accountId);
        if (!latest) return;
        const result = await wxLoginAdapter.keepWxCredentialAlive(latest);
        if (!result.Success) {
          log('错误', `微信凭证保活失败: ${latest.name} - ${result.Message || '未知错误'}`, {
            accountId: String(accountId), accountName: latest.name,
          });
        }
      }, { preventOverlap: true });
    }

    if (!cfg.enabled) return;

    scheduler.setIntervalTask(taskName, cfg.intervalMinutes * 60000, () => {
      refreshAccountCode(accountId, 'timer');
    }, { preventOverlap: true });

    log('系统', `自动刷新 Code 已启用: ${  account.name  }，间隔 ${  cfg.intervalMinutes  } 分钟`, {
      accountId: String(accountId),
      accountName: account.name,
    });
  }

  function rescheduleAll() {
    scheduler.clearAll();
    const data = getAccounts();
    const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
    for (const account of accounts) {
      scheduleAccount(account.id);
    }
  }

  function stopAccount(accountId) {
    scheduler.clear(getTaskName(accountId));
    scheduler.clear(getKeepaliveTaskName(accountId));
    scheduler.clear(`relogin_${String(accountId || '')}`);
    scheduler.clear(getResumeTaskName(accountId));
  }

  /** 账号是否处于「手动暂停」且尚未到期 */
  function isAccountPaused(accountId) {
    const account = findAccount(accountId);
    const until = Number(account && account.pausedUntil) || 0;
    return until > Date.now();
  }

  /** 剩余暂停毫秒数，未暂停返回 0 */
  function getPausedRemainingMs(accountId) {
    const account = findAccount(accountId);
    const until = Number(account && account.pausedUntil) || 0;
    return until > Date.now() ? until - Date.now() : 0;
  }

  /** 清除暂停标记 */
  function clearPause(accountId) {
    const account = findAccount(accountId);
    if (!account || !account.pausedUntil) return false;
    addOrUpdateAccount({ id: account.id, pausedUntil: 0 });
    return true;
  }

  /**
   * 暂停账号：取消该号的 Code 刷新 / 凭据保活 / 待重登任务，
   * 并在 delayMs 后自动重新拉起并恢复自动化。
   * delayMs <= 0 表示「彻底取消、不安排恢复」（删除账号时使用）。
   */
  function pauseAccount(accountId, delayMs = MANUAL_PAUSE_MS) {
    const account = findAccount(accountId);
    if (!account) return false;
    const id = String(account.id);

    // 先清掉所有定时任务，避免旧任务把刚暂停的号又拉起来。
    scheduler.clear(getTaskName(id));
    scheduler.clear(getKeepaliveTaskName(id));
    scheduler.clear(`relogin_${id}`);
    scheduler.clear(getResumeTaskName(id));

    if (!(delayMs > 0)) {
      addOrUpdateAccount({ id, pausedUntil: 0 });
      return false;
    }

    const pausedUntil = Date.now() + delayMs;
    addOrUpdateAccount({ id, pausedUntil });
    scheduler.setTimeoutTask(getResumeTaskName(id), delayMs, () => {
      resumeAccount(id, 'manual_resume');
    });

    const minutes = Math.round(delayMs / 60000);
    addAccountLog('account_paused', `账号 ${account.name} 已暂停，${minutes} 分钟后自动恢复自动化`,
      account.id, account.name, { pausedUntil });
    log('系统', `账号 ${account.name} 已暂停，${minutes} 分钟后自动恢复自动化`, {
      accountId: id, accountName: account.name, pausedUntil,
    });
    return true;
  }

  /**
   * 恢复账号：清掉暂停标记 → 刷新 Code → 重启 worker → 重新挂上定时任务。
   */
  async function resumeAccount(accountId, reason = 'manual_resume') {
    const account = findAccount(accountId);
    if (!account) return false;
    const id = String(account.id);
    clearPause(id);
    scheduler.clear(getResumeTaskName(id));

    const controls = typeof resolveWorkerControls === 'function' ? (resolveWorkerControls() || {}) : {};
    let ok = false;
    try {
      ok = await refreshAccountCode(id, reason);
    } catch (err) {
      log('错误', `账号 ${account.name} 恢复失败: ${err.message}`, {
        accountId: id, accountName: account.name,
      });
    }

    if (!ok && typeof controls.startWorker === 'function') {
      // 微信凭证失效时也要把号拉起来，让面板显示真实状态而不是静默消失。
      controls.startWorker({ ...account, pausedUntil: 0 });
    }

    // 恢复定时任务：Code 刷新 + 凭据保活。
    scheduleAccount(id);

    if (ok) {
      addAccountLog('account_resumed', `账号 ${account.name} 已恢复自动化`, account.id, account.name, { reason });
      log('系统', `账号 ${account.name} 已恢复自动化`, {
        accountId: id, accountName: account.name, reason,
      });
    }
    return ok;
  }

  /**
   * 按剩余时间安排恢复（用于重启后接续尚未到期的暂停）。
   */
  function scheduleResume(accountId, remainingMs) {
    const account = findAccount(accountId);
    if (!account || !(remainingMs > 0)) return false;
    const id = String(account.id);
    scheduler.clear(getResumeTaskName(id));
    scheduler.setTimeoutTask(getResumeTaskName(id), remainingMs, () => {
      resumeAccount(id, 'manual_resume');
    });
    const minutes = Math.max(1, Math.round(remainingMs / 60000));
    log('系统', `账号 ${account.name} 仍在暂停中，${minutes} 分钟后自动恢复自动化`, {
      accountId: id, accountName: account.name,
    });
    return true;
  }

  /** 该账号是否已经有重登任务在排队（避免外部重复排班把倒计时重置掉） */
  function isReloginPending(accountId) {
    return scheduler.has(`relogin_${String(accountId || '')}`);
  }

  function scheduleRelogin(accountId, reason = 'offline') {
    const cfg = normalizeConfig(accountId);
    if (!cfg.enabled) return false;
    const account = findAccount(accountId);
    if (!account || account.platform !== 'wx' || !account.loginBuffer) return false;
    const recovery = getRecoveryState(accountId);
    // 达到上限时不停摆：降级成 30 分钟一次的重试，并重置计数。
    // 原来的「熔断」是永久放弃，账号会一直离线到进程重启 —— 这比多试几次糟糕得多。
    const degraded = recovery.attempts >= MAX_DAILY_RECOVERIES
      || recovery.failures >= MAX_CONSECUTIVE_FAILURES;
    const delayMs = degraded ? DEGRADED_RELOGIN_DELAY_MS : KICKOUT_RELOGIN_DELAY_MS;
    if (degraded) {
      addAccountLog('auto_relogin_degraded',
        `自动恢复次数已达上限，${Math.round(DEGRADED_RELOGIN_DELAY_MS / 60000)} 分钟后重试`,
        account.id, account.name, { reason, ...recovery });
      recovery.attempts = 0;
      recovery.failures = 0;
    }
    const taskName = `relogin_${String(accountId || '')}`;
    scheduler.clear(taskName);
    scheduler.setTimeoutTask(taskName, delayMs, () => {
      refreshAccountCode(accountId, reason);
    });
    const minutes = Math.round(delayMs / 60000);
    log('系统', `账号 ${account.name} 将在 ${minutes} 分钟后自动刷新凭证并重登（被顶号后会自动顶回去）`, {
      accountId: String(accountId), accountName: account.name, reason,
    });
    return true;
  }

  return {
    refreshAccountCode,
    scheduleAccount,
    rescheduleAll,
    stopAccount,
    pauseAccount,
    resumeAccount,
    clearPause,
    scheduleResume,
    isAccountPaused,
    getPausedRemainingMs,
    scheduleRelogin,
    isReloginPending,
    MANUAL_PAUSE_MS,
    KICKOUT_RELOGIN_DELAY_MS,
    KICKOUT_RELOGIN_DELAY_MIN,
  };
}

module.exports = { createAutoCodeRefreshService };
