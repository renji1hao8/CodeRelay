# 登录自动启动

先用 `start.cmd` 验证手动启动。需要登录自动启动时，再运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy/register-tasks.ps1
```

它会注册当前 Windows 用户的登录启动与看门狗任务，安装时可能要求管理员确认。后端仍以用户会话身份运行，不改为 SYSTEM。

`deploy/bootstrap.ps1` 只会尝试启动本机配置中明确填写的可选程序。空路径会跳过。更换目录后重新注册任务；卸载时在 Windows 任务计划程序中移除 RemoteCC 相关任务。
