/**
 * 二维码登录服务 - 支持 QQ 扫码登录和小程序登录
 *
 * 功能：
 * - QQ 网页扫码登录（VIP/QZone 渠道）
 * - QQ 小程序登录码生成与状态轮询
 */
const { Buffer } = require('node:buffer');
const axios = require('axios');
const QRCode = require('qrcode');
const { CookieUtils, HashUtils } = require('../utils/qrutils');

// 浏览器 UA
const ChromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---- 授权码提取（兼容 /ide/login 不同版本的响应结构）----

/** 授权码通常是长串；短数字、布尔值、状态码都排除掉 */
function looksLikeAuthCode(value) {
  const s = String(value || '').trim();
  if (s.length < 8) return false;
  if (/^[+-]?\d+$/.test(s)) return s.length >= 16;
  return true;
}

/** 在响应对象里递归寻找真正的授权码（顶层 code 是状态码，授权码一般在 data 里） */
function findAuthCode(node, depth = 0) {
  if (!node || depth > 6) return '';
  if (typeof node === 'string') return looksLikeAuthCode(node) ? node.trim() : '';
  if (typeof node !== 'object') return '';

  for (const key of ['code', 'authCode', 'authorization_code', 'auth_code', 'loginCode']) {
    const val = node[key];
    if (typeof val === 'string' && looksLikeAuthCode(val)) return val.trim();
  }
  for (const [key, val] of Object.entries(node)) {
    if (key.toLowerCase() === 'code' && typeof val !== 'object') continue;
    const found = findAuthCode(val, depth + 1);
    if (found) return found;
  }
  return '';
}

// ---- QQ 网页扫码登录渠道预设 ----

const QQ_VIP_PRESET = {
  name: 'QQ会员 (VIP)',
  description: 'QQ会员官网',
  aid: '8000201',
  daid: '18',
  redirectUri: 'https://vip.qq.com/loginsuccess.html',
  referrer: 'https://xui.ptlogin2.qq.com/cgi-bin/xlogin?appid=8000201&style=20&s_url=https%3A%2F%2Fvip.qq.com%2Floginsuccess.html&maskOpacity=60&daid=18&target=self',
};

const QQ_QZONE_PRESET = {
  name: 'QQ空间 (QZone)',
  description: 'QQ空间网页版',
  aid: '549000912',
  daid: '5',
  redirectUri: 'https://qzs.qzone.qq.com/qzone/v5/loginsucc.html?para=izone',
  referrer: 'https://qzone.qq.com/',
};

// ---- QQ 扫码登录会话 ----

class QRLoginSession {
  static Presets = { vip: QQ_VIP_PRESET, qzone: QQ_QZONE_PRESET };

  /**
   * 请求生成二维码
   * @param {'vip'|'qzone'} presetName - 登录渠道
   * @returns {{ qrsig, qrcode, url }}
   */
  static async requestQRCode(presetName = 'vip') {
    const preset = this.Presets[presetName] || this.Presets.vip;
    const params = new URLSearchParams({
      appid: preset.aid,
      e: '2',
      l: 'M',
      s: '3',
      d: '72',
      v: '4',
      t: String(Math.random()),
      daid: preset.daid,
    });
    params.set('u1', preset.redirectUri);

    const url = `https://ssl.ptlogin2.qq.com/ptqrshow?${params.toString()}`;

    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: {
          Referer: preset.referrer || 'https://xui.ptlogin2.qq.com/',
          'User-Agent': ChromeUA,
        },
      });

      const qrsig = CookieUtils.getValue(response.headers['set-cookie'], 'qrsig');
      const qrcodeBase64 = Buffer.from(response.data).toString('base64');

      return {
        qrsig,
        qrcode: `data:image/png;base64,${qrcodeBase64}`,
        url,
      };
    } catch (err) {
      console.error('Request QRCode Error:', err.message);
      throw err;
    }
  }

  /**
   * 检查扫码状态
   * @param {string} qrsig - 二维码签名
   * @param {'vip'|'qzone'} presetName - 登录渠道
   * @returns {{ ret, msg, nickname, jumpUrl, cookie }}
   */
  static async checkStatus(qrsig, presetName = 'vip') {
    const preset = this.Presets[presetName] || this.Presets.vip;
    const ptqrtoken = HashUtils.hash(qrsig);

    const params = new URLSearchParams({
      ptqrtoken: String(ptqrtoken),
      from_ui: '1',
      aid: preset.aid,
      daid: preset.daid,
      action: `0-0-${Date.now()}`,
      pt_uistyle: '40',
      js_ver: '21020514',
      js_type: '1',
    });
    params.set('u1', preset.redirectUri);

    const url = `https://ssl.ptlogin2.qq.com/ptqrlogin?${params.toString()}`;

    try {
      const response = await axios.get(url, {
        headers: {
          Cookie: `qrsig=${qrsig}`,
          Referer: preset.referrer || 'https://xui.ptlogin2.qq.com/',
          'User-Agent': ChromeUA,
        },
      });

      const data = response.data;
      const match = data.match(/ptuiCB\((.+)\)/);
      if (!match) throw new Error('Invalid response format');

      // 提取回调参数（JavaScript 字符串字面量）
      const args = [];
      const strRe = /'([^']*)'/g;
      for (let m = strRe.exec(match[1]); m !== null; m = strRe.exec(match[1])) {
        args.push(m[1]);
      }

      const [ret, , jumpUrl, , msg, nickname] = args;
      return {
        ret,
        msg,
        nickname,
        jumpUrl,
        cookie: response.headers['set-cookie'],
      };
    } catch (err) {
      console.error('Check Status Error:', err.message);
      throw err;
    }
  }
}

// ---- QQ 小程序登录 ----

const QQ_FARM_MINI_PROGRAM_PRESET = {
  name: 'QQ经典农场 (Farm)',
  description: 'QQ经典农场小程序',
  appid: '1112386029',
};

class MiniProgramLoginSession {
  static QUA = 'V1_HT5_QDT_0.70.2209190_x64_0_DEV_D';
  static Presets = { farm: QQ_FARM_MINI_PROGRAM_PRESET };

  static getHeaders() {
    return {
      qua: MiniProgramLoginSession.QUA,
      host: 'q.qq.com',
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': ChromeUA,
    };
  }

  /**
   * 请求小程序登录码
   * @returns {{ code, url, image }}
   */
  static async requestLoginCode() {
    try {
      const response = await axios.get('https://q.qq.com/ide/devtoolAuth/GetLoginCode', {
        headers: this.getHeaders(),
      });
      const { code, data } = response.data;

      if (+code !== 0) throw new Error('获取登录码失败');

      const loginCode = data.code || '';
      const url = `https://h5.qzone.qq.com/qqq/code/${loginCode}?_proxy=1&from=ide`;
      const image = await QRCode.toDataURL(url, {
        width: 300,
        margin: 1,
        errorCorrectionLevel: 'M',
      });

      return { code: loginCode, url, image };
    } catch (err) {
      console.error('MP Request Login Code Error:', err.message);
      throw err;
    }
  }

  /**
   * 查询扫码状态
   * @param {string} code - 登录码
   * @returns {{ status: 'Wait'|'OK'|'Used'|'Error', ticket?, uin?, nickname? }}
   */
  static async queryStatus(code) {
    try {
      const response = await axios.get(
        `https://q.qq.com/ide/devtoolAuth/syncScanSateGetTicket?code=${code}`,
        { headers: this.getHeaders() }
      );

      if (response.status !== 200) return { status: 'Error' };

      const { code: apiCode, data } = response.data;

      if (+apiCode === 0) {
        const result = { status: 'Wait' };
        if (+data.ok !== 1) return result;
        return {
          status: 'OK',
          ticket: data.ticket,
          uin: data.uin,
          nickname: data.nick || '',
        };
      }

      if (+apiCode === -10001) return { status: 'Used' };

      return { status: 'Error', msg: `Code: ${apiCode}` };
    } catch (err) {
      console.error('MP Query Status Error:', err.message);
      throw err;
    }
  }

  /**
   * 用 ticket 换取授权码
   * @param {string} ticket
   * @param {string} appid - 默认 '1112386029'
   */
  static async getAuthCode(ticket, appid = '1112386029') {
    try {
      return await this._exchangeAuthCode(ticket, appid);
    } catch (err) {
      // 这里必须抛出而不是吞掉错误：上层曾把错误码（如 -3000）当成登录 Code 入库，
      // 导致 WebSocket 握手带上 code=-3000 被网关直接 400 拒绝。
      console.error('[QQ扫码] 换取授权码失败:', err.message);
      throw err;
    }
  }

  static async _exchangeAuthCode(ticket, appid) {
    let response;
    try {
      response = await axios.post(
        'https://q.qq.com/ide/login',
        { appid, ticket },
        { headers: this.getHeaders() }
      );
    } catch (err) {
      throw new Error(`腾讯换码接口请求失败: ${err.message}`);
    }
    if (response.status !== 200) {
      throw new Error(`腾讯换码接口 HTTP ${response.status}`);
    }

    const body = response.data || {};
    // 脱敏后的原始响应，便于定位上游接口结构变化（授权码只显示长度）
    const raw = JSON.stringify(body).slice(0, 500)
      .replace(/[A-Za-z0-9_-]{16,}/g, (m) => `<str:${m.length}>`);

    // 顶层 code 是接口状态码：成功为 0；负数/短数字都是失败码（-3000、-13200 等）。
    // 不能把它当授权码返回。
    const topCode = body.code;
    const statusLike = typeof topCode === 'number'
      || (typeof topCode === 'string' && /^-?\d{1,8}$/.test(topCode.trim()));
    if (statusLike && Number(topCode) !== 0) {
      // -3000 是腾讯停用「QQ 开发者工具扫码换码」渠道后返回的固定拒绝码，
      // 本地无法修复，继续重复扫码没有意义，直接给出可操作的替代方案。
      const hint = Number(topCode) === -3000
        ? '；该扫码换码渠道已被腾讯停用，请改用「抓包登录」或「手动填码」获取 Code'
        : '';
      throw new Error(`腾讯换码失败 (code=${topCode} ${body.message || ''})${hint}`.trim()
        + ` | 响应: ${raw}`);
    }

    const authCode = findAuthCode(body);
    if (!authCode) {
      throw new Error(`换码接口未返回有效授权码 | 响应: ${raw}`);
    }
    console.log(`[QQ扫码] 换取授权码成功，长度 ${authCode.length}`);
    return authCode;
  }
}

module.exports = {
  QRLoginSession,
  MiniProgramLoginSession,
  // 导出给测试：授权码提取与状态码判定的边界行为必须可回归
  looksLikeAuthCode,
  findAuthCode,
};
