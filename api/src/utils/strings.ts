/* 
    Convert a string from snake_case to camelCase
*/
export function snakeToCamel(str: string): string {
    const cleanStr = str.toLowerCase();
    let newStr = '';
    for (let i = 0; i < cleanStr.length; i++) {
        if (['_', '-', ' '].some((s) => cleanStr[i].includes(s))) {
            newStr = newStr + cleanStr[i + 1].toUpperCase();
            i++;
        } else {
            newStr = newStr + cleanStr[i];
        }
    }
    return newStr;
}

export function toCamel(s: string): string {
    return s.toLowerCase().replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

export function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
