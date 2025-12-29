# Safe script to update all remaining stack files to use external stacks.css

Write-Host "=== Stack Files Update Script ===" -ForegroundColor Cyan
Write-Host ""

# Get all stack HTML files
$stackFiles = Get-ChildItem -Path "stacks" -Recurse -Filter "*.html"
$updated = 0
$skipped = 0
$errors = 0

foreach ($file in $stackFiles) {
    $content = Get-Content $file.FullName -Raw
    
    # Skip if already has stacks.css
    if ($content -match 'stacks\.css') {
        Write-Host "SKIP: $($file.Name) - already updated" -ForegroundColor Yellow
        $skipped++
        continue
    }
    
    Write-Host "`nPROCESSING: $($file.Name)" -ForegroundColor Cyan
    
    # Create backup
    $backupPath = "$($file.FullName).backup"
    Copy-Item $file.FullName $backupPath -Force
    
    try {
        # Step 1: Add stacks.css link
        if ($content -match '<link rel="stylesheet" href="/css/global\.css">') {
            $content = $content -replace '(<link rel="stylesheet" href="/css/global\.css">)', '$1
    <link rel="stylesheet" href="/css/stacks.css">'
            Write-Host "  Added stacks.css link" -ForegroundColor Green
        } elseif ($content -match '<title>.*?</title>') {
            # No global.css, add both
            $content = $content -replace '(</title>)', '$1
    <link rel="stylesheet" href="/css/global.css">
    <link rel="stylesheet" href="/css/stacks.css">'
            Write-Host "  Added global.css and stacks.css links" -ForegroundColor Green
        } else {
            throw "Could not find insertion point for CSS links"
        }
        
        # Step 2: Extract layer-specific color styles
        $layerBorderStyles = @()
        $layerIconStyles = @()
        
        if ($content -match '(?s)<style>(.*?)</style>') {
            $styleBlock = $matches[1]
            
            # Extract .layer.classname { border-left: ... }
            $borderMatches = [regex]::Matches($styleBlock, '\.layer\.(\w+)\s*\{[^}]*border-left:\s*4px\s+solid\s+([^;]+);[^}]*\}')
            foreach ($match in $borderMatches) {
                $className = $match.Groups[1].Value
                $color = $match.Groups[2].Value.Trim()
                $layerBorderStyles += "        .layer.$className { border-left: 4px solid $color; }"
            }
            
            # Extract .classname .layer-icon { background: ... }
            $iconMatches = [regex]::Matches($styleBlock, '\.(\w+)\s+\.layer-icon\s*\{[^}]*background:\s*([^;]+);')
            foreach ($match in $iconMatches) {
                $className = $match.Groups[1].Value
                $color = $match.Groups[2].Value.Trim()
                $layerIconStyles += "        .$className .layer-icon { background: $color; }"
            }
        }
        
        # Step 3: Build minimal inline styles
        $minimalStyles = '        :root {
            --glass: rgba(255,255,255,0.10);
            --text: #e6e6e6;
            --muted: #b3b3b3;
            --border: rgba(255,255,255,0.22);
            --shadow: 0 10px 30px rgba(0,0,0,0.15);
            --blur: 12px;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }'
        
        if ($layerBorderStyles.Count -gt 0 -or $layerIconStyles.Count -gt 0) {
            $minimalStyles += "`n`n        /* Layer-specific colors */"
            $minimalStyles += "`n" + ($layerBorderStyles -join "`n")
            $minimalStyles += "`n`n" + ($layerIconStyles -join "`n")
            Write-Host "  Preserved $($layerBorderStyles.Count) border styles and $($layerIconStyles.Count) icon styles" -ForegroundColor Green
        }
        
        # Step 4: Replace entire style block
        $newStyleBlock = "<style>`n$minimalStyles`n    </style>"
        $content = $content -replace '(?s)<style>.*?</style>', $newStyleBlock
        
        # Step 5: Clean up any duplicate </head><body> tags that might have been created
        $content = $content -replace '(?s)</style>\s*</head>\s*<body>\s*[^<]*</head>\s*<body>', "</style>`n</head>`n<body>"
        
        # Step 6: Write back
        Set-Content -Path $file.FullName -Value $content -NoNewline
        
        Write-Host "  Updated successfully!" -ForegroundColor Green
        $updated++
        
    } catch {
        Write-Host "  ERROR: $($_.Exception.Message)" -ForegroundColor Red
        # Restore from backup on error
        Copy-Item $backupPath $file.FullName -Force
        Remove-Item $backupPath -Force
        $errors++
    }
}

Write-Host "`n=== Summary ===" -ForegroundColor Cyan
Write-Host "Updated: $updated" -ForegroundColor Green
Write-Host "Skipped: $skipped" -ForegroundColor Yellow
Write-Host "Errors:  $errors" -ForegroundColor $(if ($errors -gt 0) { "Red" } else { "Green" })
Write-Host "`nBackup files (.backup) have been created for all modified files." -ForegroundColor Yellow
Write-Host "Test the site and if everything works, you can delete the backup files." -ForegroundColor Yellow
