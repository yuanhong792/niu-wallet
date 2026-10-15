param([ValidateSet('protect','unprotect')][string]$Mode)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$inputBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
if ($Mode -eq 'protect') {
    $result = [Security.Cryptography.ProtectedData]::Protect($inputBytes, $null, $scope)
} else {
    $result = [Security.Cryptography.ProtectedData]::Unprotect($inputBytes, $null, $scope)
}
[Console]::Out.Write([Convert]::ToBase64String($result))
[Array]::Clear($inputBytes, 0, $inputBytes.Length)
