# 参与开发

先阅读 [架构](docs/ARCHITECTURE.md) 和 [构建](docs/BUILD.md)。提交改动时说明触发问题的操作、变更后的行为，以及实际完成的验证。

```powershell
npm test
npm run typecheck
npm --prefix mobile run typecheck
node scripts/audit-public-source.mjs
```

消息归一化、序号合并和投递状态请补有失败判据的用例。UI 小调整不要求复制实现的测试；请说明是否经过手机实测。

不要提交本机配置、运行数据、聊天截图、证书和签名文件。私有调试材料放在 `.local/`。新增第三方代码要保留其许可和来源；默认配置不应绑定某一供应商、代理或目录。

桌面发送只能使用已核验的目标和正常授权的传输。发生未知投递结果时保留请求标识，不自动换通道、新建会话或重发。审批和任务操作必须重新核对归属及状态。
