/**
 * 抓包会话管理
 *
 * 每个会话对应一次 iPhone 抓包登录流程：
 * - 独立 MITM 代理端口
 * - 抓到的 code/openid
 * - 好友 GID 集合与来源
 * - 对外公布的代理地址（多 IP：局域网 / Tailscale）
 */

function createSessionStore({ config } = {}) {
  const sessions = new Map();

  function createSession(id, platform = 'qq') {
    const session = {
      id,
      platform: platform === 'wx' ? 'wx' : 'qq',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cancelled: false,
      completed: false,
      code: '',
      openId: '',
      friendGids: new Set(),
      friendSource: '',
      friendListComplete: false,
      proxy: {
        running: false,
        status: 'idle',
        error: '',
        port: 0,
        startedAt: '',
      },
      publicInfo: {
        host: '',
        addresses: [],
        mitmPort: 0,
        mitmProxyAutoStopSec: config.autoStopSec || 900,
        certUrl: '/cert/mitmproxy-ca-cert.cer',
      },
      bypassHosts: [],
      // 抓到的 WebSocket 帧：用于还原活动协议（命令字 / 字段号 / 返回结构）。
      // 只留最近若干帧，避免长时间抓包把内存吃满。
      wsFrames: [],
      wsFrameBytes: 0,
    };
    sessions.set(id, session);
    return session;
  }

  /**
   * 记录一条 WebSocket 帧。
   * @param {object} session
   * @param {'send'|'receive'} direction - send=客户端→服务器，receive=服务器→客户端
   * @param {Buffer} buffer - 原始二进制帧载荷
   */
  function addWsFrame(session, direction, buffer) {
    if (!session || !buffer || !buffer.length) return;
    const MAX_FRAMES = 4000;
    const MAX_BYTES = 16 * 1024 * 1024;
    if (session.wsFrames.length >= MAX_FRAMES || session.wsFrameBytes >= MAX_BYTES) {
      session.wsFrames.shift();
    }
    session.wsFrames.push({
      type: direction === 'send' ? 'send' : 'receive',
      opcode: 2,
      data: buffer.toString('base64'),
      at: Date.now(),
    });
    session.wsFrameBytes += buffer.length;
  }

  /**
   * 把某个会话的 WS 帧导出成 HAR。
   * 同时带 Chrome（data/opcode）和 Charles（payload.buffer/flow）两套字段，
   * inspect-activity-har.js 与其它 HAR 工具都能直接读。
   */
  function exportSessionHar(session) {
    if (!session) return null;
    const frames = Array.isArray(session.wsFrames) ? session.wsFrames : [];
    return {
      log: {
        version: '1.2',
        creator: { name: 'qq-farm-bot capture', version: '1.0' },
        entries: [
          {
            startedDateTime: new Date(session.createdAt || Date.now()).toISOString(),
            time: 0,
            request: { method: 'WS', url: 'wss://gate-obt.nqf.qq.com/prod/ws' },
            response: { status: 101, statusText: 'Switching Protocols' },
            _webSocketMessages: frames.map(frame => ({
              // Chrome 风格
              type: frame.type,
              opcode: frame.opcode,
              data: frame.data,
              time: frame.at,
              // Charles 风格：inspect-activity-har.js 读的就是这套
              payload: { type: 'string', buffer: frame.data },
              flow: frame.type === 'send' ? 0 : 1,
              timestamp: frame.at,
            })),
          },
        ],
      },
    };
  }

  function getSession(id) {
    return sessions.get(String(id || '')) || null;
  }

  function hasSession(id) {
    return sessions.has(String(id || ''));
  }

  function deleteSession(id) {
    const key = String(id || '');
    const session = sessions.get(key);
    if (session && session.proxy && typeof session.proxy.stop === 'function') {
      try {
        session.proxy.stop();
      } catch { /* 忽略 */ }
    }
    sessions.delete(key);
  }

  function markUpdated(session) {
    session.updatedAt = Date.now();
  }

  /** 启动代理后记录代理信息 */
  function setProxyInfo(session, proxyInfo) {
    session.proxy = {
      running: proxyInfo.running === true,
      status: proxyInfo.status || 'running',
      error: proxyInfo.error || '',
      port: Number(proxyInfo.port) || 0,
      startedAt: proxyInfo.startedAt || new Date().toISOString(),
      stop: proxyInfo.stop || null,
    };
    session.publicInfo = {
      host: proxyInfo.host || '',
      addresses: Array.isArray(proxyInfo.addresses) ? proxyInfo.addresses : [],
      mitmPort: Number(proxyInfo.port) || 0,
      mitmProxyAutoStopSec: proxyInfo.autoStopSec || config.autoStopSec || 900,
      certUrl: proxyInfo.certUrl || '/cert/mitmproxy-ca-cert.cer',
    };
    if (Array.isArray(proxyInfo.bypassHosts)) session.bypassHosts = proxyInfo.bypassHosts;
    markUpdated(session);
  }

  function setProxyError(session, error) {
    if (!session.proxy) session.proxy = {};
    session.proxy.error = String(error || '');
    session.proxy.status = 'error';
    session.proxy.running = false;
    markUpdated(session);
  }

  /** 记录抓到的登录 code / openid */
  function addCode(session, { code = '', openId = '', clientVersion = '' } = {}) {
    let changed = false;
    const cleanCode = String(code || '').trim();
    const cleanOpenId = String(openId || '').trim();
    if (cleanCode && !session.code) {
      session.code = cleanCode;
      changed = true;
    }
    if (cleanOpenId && !session.openId) {
      session.openId = cleanOpenId;
      changed = true;
    }
    if (code === session.code && /^\d+(?:\.\d+){2,4}_\d{8}$/.test(clientVersion) && !session.clientVersion) {
      session.clientVersion = clientVersion;
      changed = true;
    }
    if (changed) markUpdated(session);
    return changed;
  }

  /** 记录好友 GID（去重） */
  function addFriendGids(session, { gids = [], source = '', complete = false } = {}) {
    let changed = false;
    for (const gid of Array.isArray(gids) ? gids : []) {
      const num = Number(gid);
      if (Number.isSafeInteger(num) && num > 0 && !session.friendGids.has(num)) {
        session.friendGids.add(num);
        changed = true;
      }
    }
    if (source) session.friendSource = source;
    if (complete) session.friendListComplete = true;
    if (changed || source || complete) markUpdated(session);
    return changed;
  }

  function getCodesArray(session) {
    if (!session.code && !session.openId) return [];
    return [{ code: session.code, gid: '', openid: session.openId, ...(session.clientVersion ? { clientVersion: session.clientVersion } : {}) }];
  }

  function buildSnapshot(session) {
    return {
      channels: {
        [session.platform]: {
          status: session.code ? 'captured' : (session.proxy.running ? 'running' : 'idle'),
          codes: getCodesArray(session),
        },
      },
      friends: {
        source: session.friendSource,
        items: [...session.friendGids].sort((a, b) => a - b).map(gid => ({ gid: String(gid) })),
        complete: session.friendListComplete === true,
      },
      publicInfo: { ...session.publicInfo },
      proxy: {
        running: session.proxy.running === true,
        status: session.proxy.status || 'idle',
        error: session.proxy.error || '',
        startedAt: session.proxy.startedAt || '',
      },
      captured: !!session.code,
    };
  }

  function listSessions() {
    return [...sessions.keys()];
  }

  /** 清理过期会话 */
  function cleanupExpired() {
    const cutoff = Date.now() - (config.sessionTtlMs || 60 * 60 * 1000);
    for (const [id, session] of sessions) {
      if (session.updatedAt < cutoff && !session.completed) {
        deleteSession(id);
      }
    }
  }

  return {
    addCode,
    addFriendGids,
    addWsFrame,
    buildSnapshot,
    cleanupExpired,
    createSession,
    deleteSession,
    exportSessionHar,
    getCodesArray,
    getSession,
    hasSession,
    listSessions,
    markUpdated,
    setProxyError,
    setProxyInfo,
  };
}

module.exports = { createSessionStore };
