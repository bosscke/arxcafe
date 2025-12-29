# Safe test script - preview changes without modifying files

Write-Host "=== PREVIEW MODE - No files will be modified ===" -ForegroundColor Yellow
Write-Host ""

$stackFiles = Get-ChildItem -Path "stacks" -Recurse -Filter "*.html"

foreach ($file in $stackFiles) {
    $content = Get-Content $file.FullName -Raw
    
    # Skip if already has stacks.css
    if ($content -match 'stacks\.css') {
        continue
    }
    
    Write-Host "File: $($file.FullName)" -ForegroundColor Cyan
    
    # Check what we'll do
    if ($content -match '<link rel="stylesheet" href="/css/global\.css">') {
        Write-Host "  ✓ Has global.css - will add stacks.css after it" -ForegroundColor Green
    } elseif ($content -match '<title>.*?</title>') {
        Write-Host "  ! No global.css - will add both global.css and stacks.css" -ForegroundColor Yellow
    } else {
        Write-Host "  ✗ ERROR: No title tag found!" -ForegroundColor Red
        continue
    }
    
    # Check for layer-specific styles that need to be preserved
    if ($content -match '(?s)<style>(.*?)</style>') {
        $styleBlock = $matches[1]
        
        # Look for layer border colors
        if ($styleBlock -match '\.layer\.\w+.*?border-left') {
            Write-Host "  ✓ Found layer border styles to preserve" -ForegroundColor Green
        }
        
        # Look for layer icon backgrounds
        if ($styleBlock -match '\.layer-icon.*?background:') {
            Write-Host "  ✓ Found layer icon styles to preserve" -ForegroundColor Green
        }
    }
    
    Write-Host ""
}

Write-Host "=== Preview complete - verify above looks correct ===" -ForegroundColor Yellow
Write-Host "If everything looks good, we can proceed with actual updates" -ForegroundColor Yellow
