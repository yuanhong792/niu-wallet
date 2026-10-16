param([string]$Source, [string]$Output)
$ErrorActionPreference = 'Stop'
$code = Get-Content -LiteralPath $Source -Raw -Encoding UTF8
$repoPath = Split-Path -Parent $PSScriptRoot
$parameters = New-Object System.CodeDom.Compiler.CompilerParameters
$parameters.GenerateExecutable = $true
$parameters.GenerateInMemory = $false
$parameters.OutputAssembly = $Output
$parameters.CompilerOptions = '/target:winexe /win32icon:"' + (Join-Path $repoPath 'assets\niu-banknote-v2.ico') + '"'
@('System.dll','System.Core.dll','System.Drawing.dll','System.Web.Extensions.dll','System.Windows.Forms.dll',(Join-Path $repoPath 'vendor\QRCoder.dll')) | ForEach-Object { $parameters.ReferencedAssemblies.Add($_) | Out-Null }
foreach ($language in @('zh-CN','en','ja','ko','es','ru')) {
    $catalog = Join-Path $repoPath ("assets\locales\" + $language + ".json")
    if (!(Test-Path -LiteralPath $catalog)) { throw "Missing language catalog: $language" }
    $parameters.EmbeddedResources.Add($catalog) | Out-Null
}
Add-Type -TypeDefinition $code -CompilerParameters $parameters
