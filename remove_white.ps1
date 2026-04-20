Add-Type -AssemblyName System.Drawing
$orig = [System.Drawing.Image]::FromFile('c:\Users\lucas\OneDrive\Área de Trabalho\projeto route\novo_logo_app.png')
$bmp = New-Object System.Drawing.Bitmap($orig)
$orig.Dispose()
$bmp.MakeTransparent([System.Drawing.Color]::White)
$bmp.Save('c:\Users\lucas\OneDrive\Área de Trabalho\projeto route\novo_logo_app_transp.png', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
