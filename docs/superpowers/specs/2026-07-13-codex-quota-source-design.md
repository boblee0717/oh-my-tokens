# Codex 配额来源选择

## Goal

避免 macOS SwiftBar 偶尔把 Codex Weekly 配额显示为 `0%`，同时保留
真实主套餐在刚重置时显示 `0%` 的能力。

## Root cause

本地 `~/.codex` 会话日志会交错写入多个 `rate_limits.limit_id`：

- 主套餐限额为 `codex`；现场同一时段上报 Weekly `44%`。
- 附加限额 `codex_bengalfox` 上报 Weekly `0%`。它过去没有
  `plan_type`，现在也会带 `plan_type: "prolite"`。

解析器按时间选取所有限额中的最新样本，且旧保护只丢弃
`plan_type == null` 的零值，因此较晚的附加限额会覆盖真实主套餐。
SwiftBar 只是如实渲染了错误的输入，不是故障源。

## Design

`host/parsers/codex.js` 将区分两类最新样本：

- `latestRawRateLimits`：所有限额中最新的一条，仅用于 credits，保持
  现有 credits 语义。
- `latestQuotaRateLimits`：优先选择 `limit_id === "codex"` 的最新一条；
  仅在日志完全没有该主 ID 时，回退到旧格式的空 ID。其他非空 ID（包括
  `codex_bengalfox` 与 `premium`）不产生主套餐配额行。

配额记录从 `latestQuotaRateLimits` 生成。移除以 `used_percent === 0` 和
`plan_type` 判断可用性的规则：主 ID 的零值是合法的刚重置状态，是否为
主套餐由 `limit_id` 决定。

## Tests and verification

测试夹具将覆盖两种现网形态：

1. `codex_bengalfox` 带 `plan_type: "prolite"` 且为 `0%` 时，仍不输出
   主套餐配额行。
2. 较早的 `codex` 主套餐 `44%` 不会被较晚的 `codex_bengalfox` `0%`
   覆盖。

运行 Codex 解析器测试、完整 host 测试、菜单栏 formatter 测试，并读取本机
报告确认显示的是主套餐配额。发布时将扩展版本从 `0.6.6` 升至 `0.6.7`，再用
支持的安装脚本同步 native host 与菜单栏运行时。

## Non-goals

- 不修改 SwiftBar 的通用合并/渲染逻辑。
- 不隐藏真实主套餐的 `0%`。
- 不改变 token、成本或 credits 的解析来源。
