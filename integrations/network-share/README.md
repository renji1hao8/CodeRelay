# 网络共享参考

Windows 上映射的共享盘以当前用户登录会话为准。后端应由同一用户启动，才能读取其映射盘。

在自己的 PowerShell 中交互式取得凭据并挂载，不把密码写进脚本：

```powershell
$credential=Get-Credential
New-PSDrive -Name R -PSProvider FileSystem -Root '\\server.example\share' -Credential $credential -Persist
```

随后把需要的共享目录显式加入 `$Roots`，需要只读时也加入 `$ReadOnlyRoots`。网络盘未连接时不会自动扩大文件权限。
