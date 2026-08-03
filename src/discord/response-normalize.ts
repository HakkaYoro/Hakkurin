// Puerto de la normalización de response_content (discord_client.py:621-654).
// Gemma a veces devuelve un string que es literal de lista Python "['a', 'b']"
// o una lista cuyos items son ese literal. Dos pasadas lo deshacen.
// Pure function — testeable sin Discord.

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
  // Paso 1: string suelto → intentar literal-lista o envolver.
  let list: string[];
  if (typeof input === 'string') {
    list = tryParseListLiteral(input) ?? [input];
  } else {
    list = input.map((x) => (typeof x === 'string' ? x : String(x)));
  }

  // Paso 2: cada item que parezca un literal-lista, expandirlo.
  const out: string[] = [];
  for (const item of list) {
    const parsed = tryParseListLiteral(item);
    if (parsed) out.push(...parsed);
    else out.push(item);
  }
  return out;
}
