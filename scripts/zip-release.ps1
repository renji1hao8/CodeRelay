param([Parameter(Mandatory=$true)][string]$Source,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
if(Test-Path -LiteralPath $Destination){throw 'Destination already exists'}
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory([IO.Path]::GetFullPath($Source),[IO.Path]::GetFullPath($Destination),[IO.Compression.CompressionLevel]::Optimal,$false)
