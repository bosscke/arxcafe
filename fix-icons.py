import os
import re
from pathlib import Path

# Simple, clean icons
CHECKMARK = 'M9 12.75L11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z'
ALERT = 'M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0zm-9 3.75h.008v.008H12v-.008z'

concepts_dir = Path('concepts-advance')

for html_file in concepts_dir.glob('*.html'):
    content = html_file.read_text(encoding='utf-8')
    original = content
    
    # Replace complex H2 SVG paths (over 80 characters) with simple checkmark
    # Pattern: <h2><svg...><path ... d="LONG_PATH" /></svg>
    def replace_complex_icon(match):
        svg_start = match.group(1)  # <h2><svg...><path...d="
        path_data = match.group(2)   # the path data
        svg_end = match.group(3)     # " /></svg>...
        
        # Use alert for negative sections, checkmark for others
        if any(word in svg_end.lower() for word in ['disadvantage', 'challenge', 'pitfall', 'bottleneck']):
            new_path = ALERT
        else:
            new_path = CHECKMARK
            
        return svg_start + new_path + svg_end
    
    # Match H2 SVG paths longer than 80 characters
    pattern = r'(<h2><svg[^>]*><path[^>]*d=")([^"]{80,})(" /></svg>)'
    content = re.sub(pattern, replace_complex_icon, content)
    
    if content != original:
        html_file.write_text(content, encoding='utf-8')
        changes = len(re.findall(pattern, original))
        print(f"Fixed {changes} complex icons in {html_file.name}")
    else:
        print(f"No changes needed in {html_file.name}")

print("Done!")
