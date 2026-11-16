export function assertUniqueTopLevelJsonMembers(serialized: string): void {
  const memberNames = new Set<string>();
  let depth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  let expectingMemberName = false;

  for (let index = 0; index < serialized.length; index += 1) {
    const character = serialized[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
        if (depth === 1 && expectingMemberName) {
          let next = index + 1;
          while (/\s/.test(serialized[next] ?? '')) {
            next += 1;
          }
          if (serialized[next] === ':') {
            const memberName = JSON.parse(serialized.slice(stringStart, index + 1)) as string;
            if (memberNames.has(memberName)) {
              throw new Error('JSON object contains a duplicate JSON member name');
            }
            memberNames.add(memberName);
            expectingMemberName = false;
          }
        }
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      stringStart = index;
    } else if (character === '{' || character === '[') {
      depth += 1;
      if (depth === 1 && character === '{') {
        expectingMemberName = true;
      }
    } else if (character === '}' || character === ']') {
      depth -= 1;
    } else if (character === ',' && depth === 1) {
      expectingMemberName = true;
    }
  }
}
