const { MiniProgramLoginSession } = require("../services/qrlogin");

function registerAdminQrLoginRoutes({ app }) {
  app.post("/api/qr/create", async (req, res) => {
    try {
      const data = await MiniProgramLoginSession.requestLoginCode();
      res.json({ ok: true, data });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/qr/check", async (req, res) => {
    const { code } = req.body || {};
    if (!code) {
      return res.status(400).json({ ok: false, error: "Missing code" });
    }

    try {
      const status = await MiniProgramLoginSession.queryStatus(code);
      if (status.status === "OK") {
        const appId = "1112386029";
        let authCode = "";
        try {
          authCode = await MiniProgramLoginSession.getAuthCode(
            status.ticket,
            appId,
          );
        } catch (error) {
          // 换码失败时绝不能把错误码（如 -3000）当成登录 Code 返回给前端入库
          return res.json({
            ok: true,
            data: {
              status: "Error",
              error: `QQ 授权码获取失败：${error.message}`,
            },
          });
        }
        if (!authCode) {
          return res.json({
            ok: true,
            data: { status: "Error", error: "QQ 授权码为空，请重新扫码" },
          });
        }
        const avatar = status.uin
          ? `https://q1.qlogo.cn/g?b=qq&nk=${  status.uin  }&s=640`
          : "";
        return res.json({
          ok: true,
          data: {
            status: "OK",
            code: authCode,
            uin: status.uin || "",
            avatar,
            nickname: status.nickname || "",
          },
        });
      }

      if (status.status === "Used") {
        return res.json({ ok: true, data: { status: "Used" } });
      }
      if (status.status === "Wait") {
        return res.json({ ok: true, data: { status: "Wait" } });
      }

      res.json({
        ok: true,
        data: {
          status: "Error",
          error: status.msg,
        },
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });
}

module.exports = { registerAdminQrLoginRoutes };
