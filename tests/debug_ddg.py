from duckduckgo_search import DDGS

def search_ddg(query):
    print(f"🔎 Buscando: '{query}'...")
    results = []
    try:
        with DDGS() as ddgs:
            # Intentar con región Venezuela (ve-es) o global si falla
            ddg_gen = ddgs.text(query, region='ve-es', max_results=5)
            if ddg_gen:
                for r in ddg_gen:
                    title = r.get("title", "Sin título")
                    link = r.get("href", "#")
                    snippet = r.get("body", "")
                    print(f"\n--- Resultado ---\nTitle: {title}\nLink: {link}\nSnippet: {snippet}")
                    results.append(f"- [{title}]({link}): {snippet}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    print("--- Test 1: Query original ---")
    search_ddg("precio dolar Venezuela hoy 26 diciembre 2025")
    
    print("\n--- Test 2: Query simple + Region VE ---")
    # Modificar search_ddg para aceptar region si es necesario, pero por ahora probemos query simple
    search_ddg("precio dolar bcv venezuela hoy")
    
    print("\n--- Test 3: DolarToday ---")
    search_ddg("dolartoday venezuela precio hoy")
