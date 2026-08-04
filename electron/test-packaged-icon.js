const assert = require('assert')
const path = require('path')
const { execFileSync } = require('child_process')
const packageMetadata = require('../package.json')

function inspectPackagedIcon(executablePath) {
  const script = String.raw`
Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:CODEX_MM_ICON_TEST_EXE)
if ($null -eq $icon) { throw 'Unable to extract the packaged application icon.' }
$bitmap = $icon.ToBitmap()
$saturatedBluePixels = 0
$visiblePixels = 0
for ($x = 0; $x -lt $bitmap.Width; $x++) {
  for ($y = 0; $y -lt $bitmap.Height; $y++) {
    $pixel = $bitmap.GetPixel($x, $y)
    if ($pixel.A -le 20) { continue }
    $visiblePixels += 1
    $maximum = [Math]::Max($pixel.R, [Math]::Max($pixel.G, $pixel.B))
    $minimum = [Math]::Min($pixel.R, [Math]::Min($pixel.G, $pixel.B))
    if (($pixel.B - $pixel.R) -gt 30 -and ($maximum - $minimum) -gt 50) {
      $saturatedBluePixels += 1
    }
  }
}
$result = [pscustomobject]@{
  width = $bitmap.Width
  height = $bitmap.Height
  visiblePixels = $visiblePixels
  saturatedBluePixels = $saturatedBluePixels
}
$bitmap.Dispose()
$icon.Dispose()
$result | ConvertTo-Json -Compress
`
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_MM_ICON_TEST_EXE: path.resolve(executablePath) },
    windowsHide: true
  })

  return JSON.parse(output.trim())
}

function assertPackagedIcon(executablePath) {
  const result = inspectPackagedIcon(executablePath)
  const totalPixels = result.width * result.height

  assert.ok(totalPixels >= 256, 'packaged executable icon is unexpectedly small')
  assert.ok(result.visiblePixels > 0, 'packaged executable icon is empty')
  assert.ok(
    result.saturatedBluePixels >= Math.ceil(totalPixels * 0.04),
    'packaged executable still uses the gray Electron default icon instead of the blue routing icon'
  )

  return result
}

if (require.main === module) {
  const executablePath = path.resolve(
    process.argv[2] ||
      path.join(
        __dirname,
        '..',
        'release',
        `ChatGPT-Model-Manager-${packageMetadata.version}-complete`,
        'ChatGPT Model Manager.exe'
      )
  )

  console.log(JSON.stringify({ executablePath, ...assertPackagedIcon(executablePath) }, null, 2))
}

module.exports = { assertPackagedIcon, inspectPackagedIcon }
