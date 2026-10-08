export function formatLabel(str: string): string {
    if (!str) return '';
    
    // Inserts a space before any capital letter, trims extra spaces, and capitalizes the very first letter
    const spaced = str.replace(/([A-Z])/g, ' $1').trim();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}