# Script to update all stack HTML files to use external stacks.css

$stackFiles = Get-ChildItem -Path "stacks" -Recurse -Filter "*.html"

foreach ($file in $stackFiles) {
    $content = Get-Content $file.FullName -Raw
    
    # Skip if already has stacks.css
    if ($content -match 'stacks\.css') {
        Write-Host "Skipping $($file.Name) - already updated" -ForegroundColor Yellow
        continue
    }
    
    Write-Host "Processing $($file.Name)..." -ForegroundColor Cyan
    
    # Add stacks.css link after global.css if it exists, or after title
    if ($content -match '<link rel="stylesheet" href="/css/global\.css">') {
        $content = $content -replace '(<link rel="stylesheet" href="/css/global\.css">)', "`$1`n    <link rel=`"stylesheet`" href=`"/css/stacks.css`">"
    } elseif ($content -match '<title>.*?</title>') {
        # Add global.css and stacks.css
        $content = $content -replace '(<title>.*?</title>)', "`$1`n    <link rel=`"stylesheet`" href=`"/css/global.css`">`n    <link rel=`"stylesheet`" href=`"/css/stacks.css`">"
    }
    
    # Extract layer-specific styles before removing common styles
    $layerColors = ""
    if ($content -match '(?s)(\.layer\.\w+\s*\{[^}]+\}.*?(?=\s*\.layer-icon))') {
        $layerBorders = $matches[1]
    }
    if ($content -match '(?s)((\.\w+\s+)?\.layer-icon\s*\{\s*background:[^}]+\})+') {
        $layerIcons = $matches[0]
    }
    
    # Build minimal inline styles (just CSS vars and layer-specific colors)
    $minimalStyles = @"
        :root {
            --glass: rgba(255,255,255,0.10);
            --text: #e6e6e6;
            --muted: #b3b3b3;
            --border: rgba(255,255,255,0.22);
            --shadow: 0 10px 30px rgba(0,0,0,0.15);
            --blur: 12px;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }
"@
    
    # Try to extract existing layer-specific color styles
    if ($content -match '(?s)<style>(.*?)</style>') {
        $existingStyles = $matches[1]
        
        # Extract layer border colors
        if ($existingStyles -match '(?s)(\.layer\.\w+\s*\{[^}]+border-left:[^}]+\}\s*)+') {
            $minimalStyles += "`n`n        /* Layer-specific colors */"
            $minimalStyles += "`n" + $matches[0].Trim()
        }
        
        # Extract layer icon backgrounds
        if ($existingStyles -match '(?s)((\.\w+\s+)?\.layer-icon\s*\{[^}]+background:[^}]+\}\s*)+') {
            if (-not ($minimalStyles -match 'Layer-specific colors')) {
                $minimalStyles += "`n`n        /* Layer-specific colors */"
            }
            $minimalStyles += "`n" + $matches[0].Trim()
        }
    }
    
    # Replace the entire style block
    $content = $content -replace '(?s)<style>.*?</style>', "<style>`n$minimalStyles`n    </style>"
    
    # Write back
    Set-Content -Path $file.FullName -Value $content -NoNewline
    Write-Host "✓ Updated $($file.Name)" -ForegroundColor Green
}

Write-Host "`nAll stack files have been updated!" -ForegroundColor Green
