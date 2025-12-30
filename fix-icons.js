const fs = require('fs');
const path = require('path');

// Simple, clean icons
const CHECKMARK = 'M9 12.75L11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z';
const ALERT = 'M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0zm-9 3.75h.008v.008H12v-.008z';

const conceptsDir = path.join(__dirname, 'concepts-advance');
const files = fs.readdirSync(conceptsDir).filter(f => f.endsWith('.html'));

files.forEach(filename => {
    const filepath = path.join(conceptsDir, filename);
    let content = fs.readFileSync(filepath, 'utf8');
    const original = content;
    
    // Replace complex H2 SVG paths (over 80 characters)
    const pattern = /(<h2><svg[^>]*><path[^>]*d=")([^"]{80,})(" \/><\/svg>)/g;
    
    content = content.replace(pattern, (match, start, pathData, end) => {
        // Use alert for negative sections
        const isNegative = end.toLowerCase().includes('disadvantage') || 
                          end.toLowerCase().includes('challenge') ||
                          end.toLowerCase().includes('pitfall') ||
                          end.toLowerCase().includes('bottleneck');
        
        const newPath = isNegative ? ALERT : CHECKMARK;
        return start + newPath + end;
    });
    
    if (content !== original) {
        fs.writeFileSync(filepath, content, 'utf8');
        const changes = (original.match(pattern) || []).length;
        console.log(`Fixed ${changes} complex icons in ${filename}`);
    } else {
        console.log(`No changes needed in ${filename}`);
    }
});

console.log('Done!');
