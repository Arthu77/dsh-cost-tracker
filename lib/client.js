window.__ModuleLoader__.load({
  id: "dsh-cost-tracker",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");

    // 兜底内置价：官方人民币价（高峰，每 1M tokens）；刷新成功后合并覆盖。
    var DEFAULT_PRICING = {
      "deepseek-v4-flash": { inMiss: 3.0, inHit: 0.10, out: 9.0 },
      "deepseek-v4-pro": { inMiss: 9.0, inHit: 0.30, out: 27.0 }
    };

    function fmtCny(v) {
      if (v >= 0.01) return "¥" + (Math.round(v * 100) / 100).toFixed(2);
      return "¥" + v.toFixed(4);
    }
    // 高峰桶按全价，非高峰桶按半价；价格单位：元/1M tokens
    function costOf(m, p) {
      var pk = m.peak || { uncached: 0, read: 0, write: 0, out: 0 };
      var of = m.off || { uncached: 0, read: 0, write: 0, out: 0 };
      return (
        (pk.uncached + pk.write) * p.inMiss + pk.read * p.inHit + pk.out * p.out
        + (of.uncached + of.write) * p.inMiss / 2 + of.read * p.inHit / 2 + of.out * p.out / 2
      ) / 1e6;
    }

    function pickBalance(data) {
      var infos = data !== null && typeof data === "object" && Array.isArray(data.balance_infos) ? data.balance_infos : [];
      var cny = infos.filter(function (i) { return i.currency === "CNY"; })[0] || infos[0];
      if (cny === undefined) return null;
      return {
        total: cny.total_balance,
        granted: cny.granted_balance,
        topped: cny.topped_up_balance,
        currency: cny.currency
      };
    }

    function stateDetail(d) {
      return d !== null && d !== undefined && Array.isArray(d.models) && d.models.length > 0 ? d.models : null;
    }

    async function api(path, body) {
      var res = await fetch(path, body
        ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : undefined);
      var data = {};
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      return data;
    }

    exports.inject = ["slots"];
    exports.apply = function apply(ctx) {
      var timer = ctx.get("timer");

      function CostLine(props) {
        var usage = props.useProjection("tokenUsage");
        var sessionId = props.sessionId;
        var pricesState = React.useState(DEFAULT_PRICING);
        var prices = pricesState[0];
        var setPrices = pricesState[1];
        var noteState = React.useState(null);
        var refreshNote = noteState[0];
        var setRefreshNote = noteState[1];
        var modelState = React.useState(null);
        var model = modelState[0];
        var setModel = modelState[1];
        var detailState = React.useState(null);
        var detail = detailState[0];
        var setDetail = detailState[1];
        var balanceState = React.useState(null);
        var balance = balanceState[0];
        var setBalance = balanceState[1];
        var errorState = React.useState(null);
        var balanceError = errorState[0];
        var setBalanceError = errorState[1];

        function applyBalance(r) {
          if (r !== null && typeof r === "object" && r.ok === true) {
            var picked = pickBalance(r.data);
            if (picked !== null) {
              setBalance(picked);
              setBalanceError(null);
              return;
            }
          }
          setBalance(null);
          setBalanceError(r !== null && typeof r === "object" && r.reason ? String(r.reason) : "未知原因");
        }

        // 会话打开时自动抓一次官方定价页 + 拉余额（静默）
        React.useEffect(function () {
          var alive = true;
          api("/api/cost-tracker/refresh-prices").then(function (r) {
            if (!alive) return;
            if (r !== null && typeof r === "object" && r.ok === true && r.prices) {
              setPrices(Object.assign({}, DEFAULT_PRICING, r.prices));
            }
          }).catch(function () {});
          api("/api/cost-tracker/balance").then(function (r) {
            if (alive) applyBalance(r);
          }).catch(function () {
            if (alive) { setBalance(null); setBalanceError("请求失败"); }
          });
          return function () { alive = false; };
        }, []);

        // 每次会话数据变化时刷新模型/用量
        React.useEffect(function () {
          var alive = true;
          Promise.all([
            api("/api/cost-tracker/model", { sessionId: sessionId }).catch(function () { return null; }),
            api("/api/cost-tracker/usage", { sessionId: sessionId }).catch(function () { return null; })
          ]).then(function (pair) {
            if (!alive) return;
            var m = pair[0];
            var d = pair[1];
            setModel(m !== null && typeof m === "object" && typeof m.model === "string" ? m.model : null);
            setDetail(d);
          });
          return function () { alive = false; };
        }, [sessionId, usage]);

        // 提示文字短暂显示后自动消失（2.5 秒）
        function flashNote(text) {
          setRefreshNote(text);
          if (timer !== undefined) timer.timeout(function () { setRefreshNote(null); }, 2500);
        }

        function refresh() {
          setRefreshNote("更新中…");
          Promise.all([
            api("/api/cost-tracker/refresh-prices").catch(function () { return null; }),
            api("/api/cost-tracker/refresh-balance").catch(function () { return null; })
          ]).then(function (pair) {
            var r = pair[0];
            var b = pair[1];
            var fail = [];
            if (r !== null && typeof r === "object" && r.ok === true && r.prices) {
              setPrices(Object.assign({}, DEFAULT_PRICING, r.prices));
            } else {
              fail.push("价格: " + (r !== null && typeof r === "object" && r.reason ? r.reason : "未知"));
            }
            if (b !== null && typeof b === "object" && b.ok === true) {
              var picked = pickBalance(b.data);
              if (picked !== null) {
                setBalance(picked);
                setBalanceError(null);
              } else {
                fail.push("余额: 数据缺失");
              }
            } else {
              setBalance(null);
              setBalanceError(b !== null && typeof b === "object" && b.reason ? String(b.reason) : "未知原因");
              fail.push("余额: " + (b !== null && typeof b === "object" && b.reason ? b.reason : "未知"));
            }
            flashNote(fail.length === 0 ? "已更新" : "部分失败: " + fail.join("；"));
          });
        }

        // 余额或用量任一存在就渲染，避免余额随用量投影抖动而消失
        if (usage === undefined && balance === null && balanceError === null && refreshNote === null) return null;
        var billedIn = usage === undefined
          ? 0
          : usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
        var hasUsage = usage !== undefined && (billedIn > 0 || usage.outputTokens > 0);

        // 会话使用过 DeepSeek 模型（价格表内）才显示；费用只计 DeepSeek 部分，
        // 混用的其他模型在悬停中注明"未计价"。
        var models = stateDetail(detail);
        var otherModels = [];
        var useDetail = models !== null;
        if (useDetail) {
          var deepCount = 0;
          for (var di = 0; di < models.length; di++) {
            if (prices[models[di].model] !== undefined) deepCount += 1;
            else otherModels.push(models[di].model);
          }
          if (deepCount === 0) return null; // 纯非 DeepSeek 会话不显示
        } else {
          if (model === null || prices[model] === undefined) return null; // 数据未到或非 DeepSeek
        }

        var parts = [];
        var detailParts = [];
        var cny = 0;
        var knownCount = 0;

        if (hasUsage) {
          if (useDetail) {
            for (var i = 0; i < models.length; i++) {
              var m = models[i];
              var p = prices[m.model];
              if (p === undefined) continue;
              knownCount += 1;
              var cost = costOf(m, p);
              cny += cost;
              detailParts.push(m.model + " " + fmtCny(cost));
            }
          } else {
            // fallback：detail 拉取失败时用当前时刻费率估算
            var now = new Date();
            var h = now.getUTCHours();
            var factor = (h >= 1 && h < 4) || (h >= 6 && h < 10) ? 1 : 0.5;
            var fp = prices[model];
            knownCount = 1;
            cny = (
              (usage.uncachedInputTokens + usage.cacheWriteTokens) * fp.inMiss
              + usage.cacheReadTokens * fp.inHit
              + usage.outputTokens * fp.out
            ) * factor / 1e6;
            detailParts.push(model + " " + fmtCny(cny));
          }

          if (useDetail && knownCount === 1 && models.length === 1) parts.push(models[0].model);
          else if (!useDetail && model !== null) parts.push(model);
          parts.push("费用约 " + fmtCny(cny));
        }

        if (balance !== null) {
          var total = Number(balance.total);
          var currency = balance.currency === "CNY" ? "¥" : "$";
          parts.push("余额 " + currency + (isFinite(total) ? total.toFixed(2) : balance.total));
        } else if (balanceError !== null && hasUsage) {
          parts.push("余额获取失败");
        }

        if (parts.length === 0 && refreshNote === null) return null;
        var el = { style: { fontSize: 12, opacity: 0.78, padding: "0 2px 2px" } };
        var titleBits = [];
        if (detailParts.length > 0) titleBits.push("按模型: " + detailParts.join(" · "));
        if (otherModels.length > 0) titleBits.push("未计价: " + otherModels.join(", "));
        if (balance !== null) {
          titleBits.push("充值 " + (balance.currency === "CNY" ? "¥" : "$") + Number(balance.topped).toFixed(2)
            + " · 赠送 " + (balance.currency === "CNY" ? "¥" : "$") + Number(balance.granted).toFixed(2));
        } else if (balanceError !== null) {
          titleBits.push("余额错误: " + balanceError);
        }
        if (titleBits.length > 0) el.title = titleBits.join(" · ");

        var children = [parts.join(" · ")];
        if (refreshNote !== null) {
          children.push(React.createElement("span", { key: refreshNote, style: { marginLeft: 8, color: refreshNote.indexOf("失败") >= 0 ? "#e5484d" : "#46a758" } }, refreshNote));
        }
        children.push(React.createElement("button", {
          onClick: refresh,
          title: "刷新价格与余额",
          style: { marginLeft: 8, background: "none", border: "none", cursor: "pointer", color: "inherit", fontSize: 12, padding: 0, opacity: 0.85 }
        }, "⟳"));
        return React.createElement("div", el, ...children);
      }

      ctx.slots.inject("conversation.composer.dock", function () {
        return ctx.slots.register(
          { name: "conversation.composer.dock", id: "cost", order: 10 },
          CostLine
        );
      });
    };
    return module.exports;
  }
});
