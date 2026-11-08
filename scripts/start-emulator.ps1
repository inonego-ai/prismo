param(
    [string]$Avd = 'Prismo_API_35',
    [string]$Serial = 'emulator-5554',
    [switch]$Headless
)
$ErrorActionPreference = 'Stop'
$sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$emulator = Join-Path $sdk 'emulator\emulator.exe'
$adb = Join-Path $sdk 'platform-tools\adb.exe'
if (-not (Test-Path -LiteralPath $emulator)) { throw 'Android emulator is not installed' }
if (-not (Test-Path -LiteralPath $adb)) { throw 'ADB is not installed' }
$avds = @(& $emulator -list-avds)
if ($Avd -notin $avds) { throw "AVD $Avd does not exist" }
$running = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'emulator.exe' -and $_.CommandLine -match ('-avd\s+' + [regex]::Escape($Avd) + '\b')
})
if (-not $running.Count) {
    $args = @('-avd', $Avd, '-gpu', 'auto', '-no-audio', '-no-boot-anim',
        '-memory', '4096', '-cores', '4')
    if ($Headless) { $args += '-no-window' }
    Start-Process -FilePath $emulator -ArgumentList $args -WorkingDirectory (Split-Path $emulator)
    Write-Output "Started Android emulator $Avd"
} else {
    Write-Output "Android emulator $Avd is already running"
}
$deadline = (Get-Date).AddMinutes(3)
do {
    $devices = @(& $adb devices)
    if (@($devices | Where-Object {
        $_ -match ('^' + [regex]::Escape($Serial) + '\s+device\b')
    }).Count) {
        $boot = (& $adb -s $Serial shell getprop sys.boot_completed) -join ''
        if ($boot.Trim() -eq '1') {
            $abi = ((& $adb -s $Serial shell getprop ro.product.cpu.abi) -join '').Trim()
            $api = ((& $adb -s $Serial shell getprop ro.build.version.sdk) -join '').Trim()
            Write-Output "PASS: $Avd booted on $Serial (API $api, $abi)"
            exit 0
        }
    }
    Start-Sleep -Seconds 3
} while ((Get-Date) -lt $deadline)
throw "AVD $Avd did not complete boot on $Serial"
