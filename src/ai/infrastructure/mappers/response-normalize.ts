// Gemma a veces serializa response_content como literal de lista Python
// "['a', 'b']", suelto o como items anidados.

function tryParseListLiteral(s: string): string[] | null {
  const t = s.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return null;
  // Literales Python usan comillas simples → las cambiamos a dobles para JSON.
  // ponytail: limitación — si un ítem contiene un apóstrofe interno (raro en la
  // salida de Gemma, pero posible en español), el replace rompe el JSON y cae al
  // fallback verbatim. Python usa ast.literal_eval (parser real). Upgrade path:
  // un mini-parser de literales Python si aparecen apóstrofes internos con frecuencia.
  const jsonish = t.replace(/'/g, '"');
  try {
    const parsed = JSON.parse(jsonish);
    if (Array.isArray(parsed)) return parsed.map((x) => String(x));
    return null;
  } catch {
    return null;
  }
}

export function normalizeResponseContent(input: string[] | string): string[] {
  let list: string[];
  if (typeof input === 'string') {
    list = tryParseListLiteral(input) ?? [input];
  } else {
    list = input.map((x) => (typeof x === 'string' ? x : String(x)));
  }

  const out: string[] = [];
  for (const item of list) {
    const parsed = tryParseListLiteral(item);
    if (parsed) out.push(...parsed);
    else out.push(item);
  }
  return out;
}
