param(
  [string]$BootstrapPython = $env:SMART_HOME_CAMERA_BOOTSTRAP_PYTHON
)

$ErrorActionPreference = 'Stop'
$homeRoot = Split-Path -Parent $PSScriptRoot
$coreSetup = Join-Path $homeRoot '..\smarthome-core\scripts\setup-camera.ps1'
$arguments = @{ VenvPath = (Join-Path $homeRoot '.venv-camera') }
if ($BootstrapPython) { $arguments.BootstrapPython = $BootstrapPython }

& $coreSetup @arguments
