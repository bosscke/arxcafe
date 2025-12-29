# Test script on XAMPP stack only

$file = Get-Item "stacks\web-application\xampp.html"

Write-Host "Testing on: $($file.Name)" -ForegroundColor Cyan
Write-Host ""

# Backup first
$backupPath = "$($file.FullName).backup"
Copy-Item $file.FullName $backupPath
Write-Host "Backup created at: $backupPath" -ForegroundColor Green

$content = Get-Content $file.FullName -Raw

# Check current state
Write-Host "`n--- Current State ---" -ForegroundColor Yellow
if ($content -match 'stacks\.css') {
    Write-Host "Already has stacks.css link" -ForegroundColor Yellow
    exit
}

if ($content -match '<link rel="stylesheet" href="/css/global\.css">') {
    Write-Host "Has global.css" -ForegroundColor Green
}
else {
    Write-Host "No global.css" -ForegroundColor Red
}

# Extract layer-specific styles
Write-Host "`n--- Extracting Layer-Specific Styles ---" -ForegroundColor Yellow
$layerStyles = @()

if ($content -match '(?s)<style>(.*?)</style>') {
    $styleBlock = $matches[1]
    
    # Find all .layer.classname { border-left: ... }
    $borderMatches = [regex]::Matches($styleBlock, '\.layer\.(\w+)\s*\{[^}]*border-left:\s*4px solid ([^;]+);')
    foreach ($match in $borderMatches) {
        $className = $match.Groups[1].Value
        $color = $match.Groups[2].Value
        $layerStyles += "        .layer.$className { border-left: 4px solid $color; }"
        Write-Host "  Found border: .$className -> $color" -ForegroundColor Cyan
    }
    
    # Find all .classname .layer-icon { background: ... }
    $iconMatches = [regex]::Matches($styleBlock, '\.(\w+)\s+\.layer-icon\s*\{[^}]*background:\s*([^;]+);')
    foreach ($match in $iconMatches) {
        $className = $match.Groups[1].Value
        $color = $match.Groups[2].Value
        $layerStyles += "        .$className .layer-icon { background: $color; }"
        Write-Host "  Found icon: .$className -> $color" -ForegroundColor Cyan
    }
}

# Add stacks.css link
Write-Host "`n--- Adding stacks.css link ---" -ForegroundColor Yellow
$content = $content -replace '(<link rel="stylesheet" href="/css/global\.css">)', '$1
    <link rel="stylesheet" href="/css/stacks.css">'
Write-Host "Added stacks.css link" -ForegroundColor Green

# Build minimal styles
$minimalStyles = '        :root {
            --glass: rgba(255,255,255,0.10);
            --text: #e6e6e6;
            --muted: #b3b3b3;
            --border: rgba(255,255,255,0.22);
            --shadow: 0 10px 30px rgba(0,0,0,0.15);
            --blur: 12px;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }'

if ($layerStyles.Count -gt 0) {
    $minimalStyles += "`n`n        /* Layer-specific colors */"
    $minimalStyles += "`n" + ($layerStyles -join "`n")
}

# Replace style block
Write-Host "`n--- Replacing style block ---" -ForegroundColor Yellow
$newStyleBlock = "<style>`n$minimalStyles`n    </style>"
$content = $content -replace '(?s)<style>.*?</style>', $newStyleBlock
Write-Host "Replaced style block" -ForegroundColor Green

# Write back
Set-Content -Path $file.FullName -Value $content -NoNewline
Write-Host "`nUpdated $($file.Name)" -ForegroundColor Green
Write-Host "`nBackup is at: $backupPath" -ForegroundColor Yellow
Write-Host "Please test the file in browser" -ForegroundColor Yellow
