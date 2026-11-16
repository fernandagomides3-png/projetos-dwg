# Visualizador DWG

Sistema web para abrir arquivos **DWG** (AutoCAD) e **DXF** no navegador, navegar com zoom e pan e consultar as **áreas dos polígonos fechados**, com os nomes dos ambientes associados automaticamente.

O arquivo é processado **no próprio navegador**, via [LibreDWG](https://www.gnu.org/software/libredwg/) compilado para WebAssembly. Nada é enviado a servidores, e por isso o site pode ser hospedado como estático na Vercel, sem backend.

## Funcionalidades

- Abrir um arquivo pelo botão **Abrir arquivo** ou **arrastando-o** para a janela.
- Renderização 2D de linhas, polilinhas (com arcos/bulge), arcos, círculos, elipses, splines, hachuras, sólidos, multilinhas, textos, cotas e blocos (inclusive blocos aninhados e em matriz). As cores seguem a tabela ACI e as cores de camada.
- **Zoom** com a roda do mouse (centrado no cursor), botões + / −, pinça no celular, **arrastar** para mover e **duplo clique** (ou tecla `F`) para enquadrar tudo.
- **Seleção**: clique em uma linha ou **dentro de um ambiente**. O painel mostra tipo, camada, bloco, área, perímetro, raio etc.
- **Painel lateral** com:
  - dados do arquivo (versão do AutoCAD, unidade, dimensões, quantidade de entidades, camadas e blocos);
  - **áreas dos polígonos fechados** (polilinhas fechadas, hachuras, círculos, elipses, splines fechadas e sólidos): soma, maior, média, tabela ordenável, área por camada, filtros por camada/tipo/busca e exportação em CSV (abre direto no Excel);
  - nome do ambiente: o texto (TEXT/MTEXT) que fica dentro de cada polígono;
  - liga/desliga de camadas;
  - contagem de entidades por tipo.
- **Unidades**: usa a unidade declarada no arquivo (`INSUNITS`). Quando ela não existe ou é implausível, estima a unidade (m, cm ou mm) pelo tamanho do desenho e avisa. É possível trocar a unidade manualmente.

### Como as áreas são calculadas

- Polilinhas: fórmula de Gauss (shoelace) **mais a área exata dos segmentos de arco** (bulge), sem aproximação por segmentos.
- Círculos e elipses: π·r² e π·a·b. O perímetro da elipse usa a aproximação de Ramanujan.
- Hachuras: soma dos contornos, **descontando as ilhas** (regra par-ímpar).
- Blocos: as áreas são transformadas pela escala da inserção.

> **Área útil:** o desenho costuma ter polígonos sobrepostos (por exemplo, a hachura do piso e a polilinha do mesmo ambiente). Para obter a área útil, filtre a camada dos ambientes (ex.: `PISO`, `AREA`, `AMBIENTES`) ou apenas o tipo desejado (polilinhas ou hachuras).

## Executar localmente

Requer Node.js 20 ou superior.

```bash
npm install
npm run dev
```

Depois, abra <http://localhost:3000>.

O `npm run build` copia o leitor WebAssembly de `node_modules/@mlightcad/libredwg-web` para `public/vendor/`. O `npm run dev` faz essa cópia e inicia um servidor estático simples.

## Publicar na Vercel

O projeto já vem configurado em [`vercel.json`](vercel.json): roda `npm install` e `npm run build` e publica a pasta `public/` como site estático.

**Pelo painel da Vercel:**

1. Envie o repositório para o GitHub.
2. Na Vercel, clique em **Add New → Project** e importe o repositório.
3. Mantenha *Framework Preset* = **Other** (o `vercel.json` já define build e pasta de saída) e clique em **Deploy**.

**Pela linha de comando:**

```bash
npx vercel          # pré-visualização
npx vercel --prod   # produção
```

## Estrutura

```
public/
  index.html        interface (canvas + painel lateral)
  css/style.css     estilos (tema claro/escuro, responsivo)
  js/app.js         interface: abrir arquivo, arrastar e soltar, painel, tabelas, CSV
  js/viewer.js      renderizador Canvas 2D: zoom, pan, seleção, índice espacial
  js/scene.js       converte o DWG em geometria 2D e calcula áreas e perímetros
  js/worker.js      Web Worker que lê o DWG com LibreDWG (WASM) sem travar a tela
  js/aci.js         tabela de cores do AutoCAD (ACI)
  vendor/           gerado no build (LibreDWG WASM), fora do git
scripts/
  copy-vendor.mjs   copia o leitor WASM para public/vendor
  serve.mjs         servidor local de desenvolvimento
vercel.json         configuração de deploy
```

## Limitações conhecidas

- Mostra apenas o **espaço do modelo** (layouts/paper space não são exibidos).
- Os padrões de hachura não são desenhados linha a linha: hachuras com padrão aparecem com preenchimento translúcido e hachuras sólidas, com preenchimento sólido.
- Os tipos de linha (tracejado etc.) e as espessuras são desenhados como linha contínua fina.
- Não são desenhados: imagens raster, tabelas, MLEADER, objetos OLE e sólidos 3D (essas entidades aparecem na contagem do painel).
- Os textos usam uma fonte genérica, então o posicionamento é aproximado. A quebra de linha do MTEXT é estimada.
- A leitura depende do LibreDWG, que cobre a maior parte dos DWGs de R13 a 2018+. Arquivos muito novos ou corrompidos podem falhar parcialmente.

## Licenças

O leitor DWG [`@mlightcad/libredwg-web`](https://github.com/mlightcad/libredwg-web) e o LibreDWG são distribuídos sob **GPL-3.0**. Ao publicar o site, os arquivos desse leitor são servidos junto com a aplicação, por isso é preciso respeitar os termos da GPL-3.0 (por exemplo, manter o código-fonte disponível).
