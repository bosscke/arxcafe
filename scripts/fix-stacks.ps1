$ErrorActionPreference = 'Stop'

$bodyBlock = @'
        body {
            font-family: ''Segoe UI'', Tahoma, Geneva, Verdana, sans-serif;
            background: {BG};
            background-attachment: fixed;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: stretch;
            padding: 20px 16px 28px;
            color: var(--text);
            overflow-x: hidden;
        }
'@

$containerBlock    = '        .container { max-width: 1100px; width: 100%; display: flex; flex-direction: column; gap: 14px; margin: 0 auto; }'
$diagramBlock      = @'
        .diagram {
            background: var(--glass);
            border: 1px solid var(--border);
            border-radius: 15px;
            padding: 15px 20px;
            box-shadow: var(--shadow);
            backdrop-filter: blur(var(--blur));
            -webkit-backdrop-filter: blur(var(--blur));
            flex: 1;
            display: flex;
            flex-direction: column;
            gap: 10px;
            overflow: hidden;
            text-align: left;
        }
'@
$stackBlock        = '        .stack-container { display: flex; flex-direction: column; gap: 10px; position: relative; flex: 1; }'
$layerBlock        = @'
        .layer {
            background: var(--glass);
            border: 1px solid var(--border);
            border-radius: 10px;
            padding: 12px 14px;
            position: relative;
            transition: transform 0.3s ease, box-shadow 0.3s ease;
            display: flex;
            align-items: flex-start;
            gap: 14px;
            backdrop-filter: blur(var(--blur));
            -webkit-backdrop-filter: blur(var(--blur));
            box-shadow: var(--shadow);
        }
'@
$layerLeftBlock    = '        .layer-left { display: flex; align-items: center; gap: 12px; flex: 0 0 220px; min-width: 0; align-self: flex-start; }'
$layerTitleBlock   = '        .layer-title { flex: 1; text-align: left; }'
$layerH2Block      = '        .layer-title h2 { font-size: 1.2em; margin-bottom: 1px; color: var(--text); }'
$layerFullBlock    = '        .layer-title .full-name { color: var(--muted); font-size: 0.75em; }'
$layerDescBlock    = '        .layer-description { color: var(--text); line-height: 1.45; font-size: 0.9em; flex: 1; text-align: left; }'
$layerDescUlBlock  = '        .layer-description ul { margin: 0; padding-left: 18px; display: block; list-style-position: outside; }'
$layerDescLiBlock  = '        .layer-description li { margin: 2px 0; }'
$arrowBlock        = '        .arrow { text-align: center; font-size: 1em; color: #667eea; margin: 4px 0; z-index: 1; }'
$flowBlock         = @'
        .flow-description {
            text-align: left;
            margin-top: 8px;
            padding: 8px 10px;
            background: var(--glass);
            border: 1px solid var(--border);
            border-radius: 8px;
            color: var(--text);
            font-size: 0.85em;
            line-height: 1.35;
            backdrop-filter: blur(var(--blur));
            -webkit-backdrop-filter: blur(var(--blur));
        }
'@
$homeBlock         = @'
        .home-btn {
            position: fixed;
            top: 20px;
            left: 20px;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            border-radius: 999px;
            border: 1px solid var(--border);
            background: var(--glass);
            color: var(--text);
            text-decoration: none;
            backdrop-filter: blur(var(--blur));
            -webkit-backdrop-filter: blur(var(--blur));
            box-shadow: var(--shadow);
            transition: all 0.2s ease;
            z-index: 100;
            font-size: 14px;
            font-weight: 600;
        }
'@
$homeHover         = '        .home-btn:hover { background: rgba(255, 255, 255, 0.15); transform: translateX(-2px); }'
$mediaBlock        = @'
        @media (max-width: 900px) {
            body { background-attachment: scroll; }
        }

        @media (max-width: 768px) {
            body { padding: 12px 10px 20px; align-items: stretch; }
            h1 { font-size: 1.8em; text-align: left; }
            .subtitle { text-align: left; }
            .container { gap: 10px; }
            .diagram { padding: 16px 14px; }
            .layer { padding: 14px; gap: 12px; }
            .layer-icon { width: 46px; height: 46px; font-size: 1.2em; }
            .layer-title h2 { font-size: 1.1em; }
            .layer-title .full-name { font-size: 0.78em; }
            .layer-description { font-size: 0.86em; }
            .layer-left { flex: 1 1 200px; min-width: 0; }
            .home-btn { position: static; margin: 10px 0 4px; }
            .usecase-card { position: static; margin: 8px 0 10px; width: 100%; }
        }

        @media (max-width: 540px) {
            body { padding: 10px 8px 18px; }
            h1 { font-size: 1.55em; }
            .subtitle { font-size: 0.92em; }
            .diagram { padding: 14px 12px; }
            .layer { flex-direction: column; align-items: flex-start; gap: 10px; }
            .layer-left { flex: 1 1 auto; min-width: auto; }
            .layer-description { font-size: 0.86em; }
            .layer-icon { width: 44px; height: 44px; font-size: 1.15em; }
            .layer-title h2 { font-size: 1.02em; }
        }
'@

$files = Get-ChildItem -Path 'stacks' -Filter '*.html' -Recurse
foreach ($f in $files) {
    $text = Get-Content $f -Raw
    if ($null -eq $text) { Write-Host "Skipping empty file $($f.FullName)"; continue }
    $text = [regex]::Replace($text, '(?s)body\s*{[^}]*?background:\s*([^;]+);[^}]*?}', { param($m) $bg=$m.Groups[1].Value; $bodyBlock.Replace('{BG}',$bg) })
    $text = [regex]::Replace($text, '(?s)\.container\s*{[^}]*?}', $containerBlock)
    $text = [regex]::Replace($text, '(?s)\.diagram\s*{[^}]*?}', $diagramBlock)
    $text = [regex]::Replace($text, '(?s)\.stack-container\s*{[^}]*?}', $stackBlock)
    $text = [regex]::Replace($text, '(?s)\.layer\s*{[^}]*?}', $layerBlock)
    $text = [regex]::Replace($text, '(?s)\.layer-left\s*{[^}]*?}', $layerLeftBlock)
    $text = [regex]::Replace($text, '(?s)\.layer-title\s*{[^}]*?}', $layerTitleBlock)
    $text = [regex]::Replace($text, '(?s)\.layer-title\s*h2\s*{[^}]*?}', $layerH2Block)
    $text = [regex]::Replace($text, '(?s)\.layer-title\s*\.full-name\s*{[^}]*?}', $layerFullBlock)
    $text = [regex]::Replace($text, '(?s)\.layer-description\s*{[^}]*?}', $layerDescBlock)
    $text = [regex]::Replace($text, '(?s)\.layer-description\s*ul\s*{[^}]*?}', $layerDescUlBlock)
    $text = [regex]::Replace($text, '(?s)\.layer-description\s*li\s*{[^}]*?}', $layerDescLiBlock)
    $text = [regex]::Replace($text, '(?s)\.arrow\s*{[^}]*?}', $arrowBlock)
    $text = [regex]::Replace($text, '(?s)\.flow-description\s*{[^}]*?}', $flowBlock)
    $text = [regex]::Replace($text, '(?s)\.home-btn\s*{[^}]*?}', $homeBlock)
    $text = [regex]::Replace($text, '(?s)\.home-btn:hover\s*{[^}]*?}', $homeHover)
    $text = [regex]::Replace($text, '(?s)@media\s*\(max-width:\s*768px\)\s*{.*?}@media\s*\(max-width:\s*540px\)\s*{.*?}', $mediaBlock)
    Set-Content -Path $f -Value $text
}
