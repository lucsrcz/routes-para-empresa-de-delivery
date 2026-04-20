Add-Type -AssemblyName System.Drawing
$orig = [System.Drawing.Image]::FromFile('c:\Users\lucas\OneDrive\Área de Trabalho\projeto route\novo_logo_app.png')
$bmp = New-Object System.Drawing.Bitmap($orig)
$orig.Dispose()

for ($y = 0; $y -lt $bmp.Height; $y++) {
    for ($x = 0; $x -lt $bmp.Width; $x++) {
        $pixel = $bmp.GetPixel($x, $y)
        # Check if near white
        if ($pixel.R -gt 235 -and $pixel.G -gt 235 -and $pixel.B -gt 235) {
            # Check to not remove the inner circle, assume outer corners are white.
            # A simple heuristic: if it's near white, make it transparent.
            $bmp.SetPixel($x, $y, [System.Drawing.Color]::Transparent)
        }
    }
}
$bmp.Save('c:\Users\lucas\OneDrive\Área de Trabalho\projeto route\novo_logo_app_transp.png', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
