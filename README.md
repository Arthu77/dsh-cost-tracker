# dsh-cost-tracker

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![dsh-plugin](https://img.shields.io/badge/dsh-plugin-4b6bff.svg)](https://github.com/Arthu77/dsh-cost-tracker)

DeepSeek Harness 费用跟踪插件：在对话框下方统计行旁显示**会话 token 费用估算**与 **DeepSeek 平台账户余额**。

## 功能

- **费用估算**：按模型 + 高峰/非高峰时段精确计价
  - 计费桶完整：输入（缓存未命中/命中/写入）+ 输出
  - 高峰时段（北京时间 9:00-12:00、14:00-18:00）全价，其余半价
  - 价格使用 [DeepSeek 官方人民币定价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)，并自动抓取更新（⟳ 手动刷新）
  - 中途换模型也能准确汇总：每个请求按当时的模型和时段分别计价
- **余额显示**：用环境配置的 `DEEPSEEK_API_KEY` 查询官方 `GET /user/balance`，每 10 分钟自动刷新
- **只认 DeepSeek**：会话使用 deepseek-v4-flash / deepseek-v4-pro 才显示；混用其他模型时只计 DeepSeek 部分（悬停可见"未计价"列表）

显示效果：

```
deepseek-v4-flash · 费用约 ¥0.37 · 余额 ¥110.00 ⟳
```

## 安装

```sh
dsh plugin --profile web add github:Arthu77/dsh-cost-tracker
```

然后重启 `dsh web`。

## 依赖

- 环境需配置 `DEEPSEEK_API_KEY`（模型调用与余额查询共用）
- 会话使用的模型需在价格表内（内置 deepseek-v4-flash / deepseek-v4-pro）

## 说明

- 官方结算另加 15% 增值税，插件费用估算不含税
- 余额查询走官方 `GET /user/balance` 接口，需网络可用

## 截图

![ScreenShot](ScreenShot.png)
