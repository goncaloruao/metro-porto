# 🚇 Metro Porto — Tracker em Tempo Real

> **PT** — Aplicação web que mostra a posição estimada dos comboios do Metro do Porto num mapa interactivo, em tempo quase-real.

> **EN** — A single-page web app showing estimated real-time positions of Metro do Porto trains on an interactive map.

---

## 📸 Screenshot

<!-- TODO: substituir pelo screenshot real depois do deploy -->
![Screenshot da aplicação Metro Porto](https://placehold.co/1200x600/1a1a2e/e0e0e0?text=Metro+Porto+Live+Tracker)

---

## ✨ Funcionalidades / Features

- 🗺️ Mapa interactivo com tema escuro (MapLibre GL + OpenFreeMap)
- 🚇 Posição estimada de cada comboio entre paragens (interpolação linear)
- 🎨 Linhas A–F com as cores oficiais do Metro do Porto
- 🔄 Actualização automática a cada 30 segundos
- 📍 Paragens visíveis com tooltip ao passar o rato
- 🖱️ Popup ao clicar num comboio com detalhes (linha, destino, progresso)
- 📊 Sidebar com contagem de comboios activos por linha
- 📱 Responsivo (funciona em mobile)

---

## 🛠️ Tech Stack

| Tecnologia | Uso |
|---|---|
| HTML5 + JavaScript (ES2022) | App completa, sem frameworks |
| [MapLibre GL JS](https://maplibre.org/) | Mapa interactivo (CDN) |
| [OpenFreeMap](https://openfreemap.org/) | Tiles de mapa gratuitos (tema escuro) |
| [Porto Digital OTP GraphQL API](https://otp.services.porto.digital/otp/routers/default/index/graphql) | Dados de horários e paragens |

---

## 🚀 Como correr localmente / How to run locally

Não é necessário nenhum build step — basta abrir o ficheiro `index.html` num browser:

```bash
# Opção 1 — abrir directamente
open index.html

# Opção 2 — servidor local simples (recomendado para evitar CORS)
npx serve .
# ou
python -m http.server 8080
```

Depois abre [http://localhost:3000](http://localhost:3000) (ou a porta indicada).

---

## 🌐 Deploy no GitHub Pages

1. Faz push deste repositório para o GitHub
2. Vai a **Settings → Pages**
3. Selecciona **"Deploy from a branch"** → **main** → **/ (root)**
4. Clica **Save**
5. A aplicação fica disponível em:
   ```
   https://<username>.github.io/metro-porto/
   ```

---

## ⚙️ Como funciona a estimativa de posição

A posição dos comboios **não é GPS em tempo real** — é calculada por interpolação:

```
fraction = (agora_em_segundos - partida_paragem_A) / (chegada_paragem_B - partida_paragem_A)
lat = lat_A + (lat_B - lat_A) * fraction
lon = lon_A + (lon_B - lon_A) * fraction
```

A API OTP fornece horários programados (e alguns em tempo real) para cada paragem. Com base na hora actual, calculamos em que segmento da linha o comboio deverá estar.

---

## 📡 Fonte de dados / Data source

**⚠️ Disclaimer:** Esta aplicação utiliza a **API pública e não oficial** do Porto Digital / OpenTripPlanner:

```
POST https://otp.services.porto.digital/otp/routers/default/index/graphql
```

- Não requer autenticação
- Dados de horários oficiais do Metro do Porto (GTFS)
- A disponibilidade e exactidão dos dados pode variar
- Esta app **não é afiliada** ao Metro do Porto nem ao Porto Digital

---

## 🙏 Créditos / Credits

- Inspirado em [tinkerp/comboios](https://github.com/tinkerp/comboios) — tracker de comboios CP
- Mapa: [MapLibre GL JS](https://maplibre.org/) + [OpenFreeMap](https://openfreemap.org/)
- API: [Porto Digital / OpenTripPlanner](https://otp.services.porto.digital/)

---

## 📄 Licença / License

MIT
