import { normalizeResponseContent } from '../src/discord/response-normalize';

// Bug histórico: Gemma devolvía response_content como string o como lista cuyo
// item era un literal de lista Python "['a','b']". El pipeline (discord_client.py:621-654)
// hace dos pasadas para deshacerlo. Aquí cubrimos esos caminos.

describe('normalizeResponseContent', () => {
  it('string suelto plano → array de 1', () => {
    expect(normalizeResponseContent('hola que tal')).toEqual(['hola que tal']);
  });

  it('string que es literal-lista Python (comillas simples) → array expandido', () => {
    expect(normalizeResponseContent("['hola', 'que']")).toEqual(['hola', 'que']);
  });

  it('array normal → se devuelve tal cual (copia)', () => {
    expect(normalizeResponseContent(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('array con un item que es literal-lista → se expande (bug visual reportado)', () => {
    expect(normalizeResponseContent(["['x', 'y']"])).toEqual(['x', 'y']);
  });

  it('string que parece lista pero no parsea → se envuelve sin romper', () => {
    expect(normalizeResponseContent('[esto no es json')).toEqual(['[esto no es json']);
  });
});
