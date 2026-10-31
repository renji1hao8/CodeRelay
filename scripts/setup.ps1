param([switch]$CheckOnly,[switch]$SkipDependencies,[ValidateSet('','LAN','Tunnel')][string]$Connection='',[AllowEmptyString()][string]$ServerUrl,[AllowEmptyString()][string]$Folders)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$node=Get-Command node.exe -ErrorAction SilentlyContinue
$portable=Join-Path $root 'runtime\node.exe'
$nodePath=if(Test-Path -LiteralPath $portable){$portable}elseif($node){$node.Source}else{''}
if(-not $nodePath){Write-Host 'Install Node.js 24 LTS (Windows x64), then run setup.cmd again: https://nodejs.org/en/download';exit 1}
$version=& $nodePath -p 'process.versions.node'
$parts=$version.Split('.')
if([int]$parts[0] -ne 24 -or [int]$parts[1] -lt 14){throw 'Use Node.js 24.14 or later in the 24.x series.'}
Write-Output "Node.js $version OK"
if($CheckOnly){& $nodePath (Join-Path $PSScriptRoot 'doctor.mjs');exit $LASTEXITCODE}
if(-not $SkipDependencies -and -not(Test-Path -LiteralPath (Join-Path $root 'server\node_modules\fastify'))){$registry=if($env:REMOTE_CC_NPM_REGISTRY){$env:REMOTE_CC_NPM_REGISTRY}else{'https://registry.npmjs.org'};Push-Location $root;try{& npx.cmd --yes "--registry=$registry" pnpm@12.11.2 "--registry=$registry" install --frozen-lockfile --prod;if($LASTEXITCODE -ne 0){throw 'Dependency installation failed. Check your network, then run setup.cmd again.'}}finally{Pop-Location}}
$config=Join-Path $root 'deploy\config.local.ps1'
if(-not(Test-Path -LiteralPath $config)){
 Write-Host 'Connection: 1 = trusted home LAN, 2 = HTTPS/private tunnel (recommended outside home)'
 $mode=if($Connection){if($Connection -eq 'LAN'){'1'}else{'2'}}else{Read-Host 'Choose 1 or 2 (default 2)'}
 $listen=if($mode -eq '1'){'0.0.0.0'}else{'127.0.0.1'}
 $url=if($PSBoundParameters.ContainsKey('ServerUrl')){$ServerUrl}else{Read-Host 'Phone server URL (leave blank to show LAN addresses at startup)'}
 if($url){$parsed=$null;if(-not [Uri]::TryCreate($url,[UriKind]::Absolute,[ref]$parsed) -or $parsed.Scheme -notin @('http','https')){throw 'Use an http:// or https:// URL.'}}
 $folders=if($PSBoundParameters.ContainsKey('Folders')){$Folders}else{Read-Host 'Project folders the phone may browse, separated by ; (blank = App files only)'}
 foreach($folder in $folders.Split(';')){if($folder.Trim() -and (-not [IO.Path]::IsPathRooted($folder.Trim()) -or -not(Test-Path -LiteralPath $folder.Trim() -PathType Container))){throw 'Each project folder must be an existing absolute directory.'}}
 function Quote-Ps([string]$value){return "'"+$value.Replace("'","''")+"'"}
 $lines=@(('$ListenHost='+(Quote-Ps $listen)),('$PublicUrl='+(Quote-Ps $url)),('$Roots='+(Quote-Ps $folders)))
 [IO.Directory]::CreateDirectory((Split-Path -Parent $config))|Out-Null
 [IO.File]::WriteAllLines($config,$lines,(New-Object Text.UTF8Encoding($true)))
}
Write-Host 'Setup complete. Install/authorize the Desktop Bridge plugin in your desktop apps (see docs/QUICKSTART.zh-CN.md), then double-click start.cmd.'
