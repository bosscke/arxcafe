# Standard icons (simple, proven paths)
$checkIcon = 'M9 12.75L11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z'
$alertIcon = 'M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0zm-9 3.75h.008v.008H12v-.008z'
$lightBulbIcon = 'M12 18v-5.25m0 0a6 6 0 0 0-6-6 6 6 0 0 0 6 6zm0 0a6 6 0 0 0 6-6 6 6 0 0 0-6 6z'

# Get all advanced concept HTML files
Get-ChildItem -Path 'c:\Users\bossc\Desktop\code\arxcafe-dev\concepts-advance\*.html' | ForEach-Object {
    $content = Get-Content $_.FullName -Raw
    
    # Replace all overly complex H2 icons with simple checkmark
    $content = $content -replace '(<h2><svg[^>]*><path[^>]*d=")([^"]{100,})(" /></svg>)', ('{0}' + $checkIcon + '{1}')
    
    Set-Content -Path $_.FullName -Value $content -NoNewline
    Write-Host "Fixed: $($_.Name)"
}
