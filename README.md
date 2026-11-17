# Dusty's Map Studio

**Dusty's Map Studio** is the interactive, print-ready successor to the original `MapMaker for Dusty.ipynb` and `Map_maker_V2.ipynb` notebooks. It brings Dusty's signature editorial map style (4.6" × 7.0" book proportions, crisp 300-DPI exports, locator globes, scale bars, and clean border toggles) into a zero-install browser studio — plus an optional local Python Cartopy engine for terrain basemaps, vector PDF/SVG exports, and multi-region batch packs.

---

## Option A: Hosting Online for Dusty (Free & Zero Server)

The entire `site/` folder is 100% static HTML, CSS, and JavaScript — no backend server, database, or API key required.

### Easiest 30-Second Option: Netlify Drop
1. Open **[Netlify Drop](https://app.netlify.com/drop)** in your browser.
2. Drag and drop the **`site/`** folder directly onto the page (or deploy from Git using the included `netlify.toml`).
3. Copy the live URL and send it to Dusty!

### GitHub Pages Option (Automated)
1. Push this repository to GitHub on the `main` branch.
2. Open your repository **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **GitHub Actions**.
4. The included workflow at [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) automatically publishes the `site/` folder on every push to `main` (and can also be triggered manually via **Actions → Run workflow**).

---

## How Dusty Uses It

1. **Search any place** — Type a country, region, strait, or city in the search bar to jump straight there.
2. **Frame Area** — Pan, zoom, and pick your projection, page size (including `4.6" × 7.0"` Book Page), and detail level.
3. **Customize the look** — Switch color themes, toggle borders on or off, highlight countries with custom fills or hatching, place city pins, and toggle the scale bar, locator globe, north arrow, or legend.
4. **Export** — Click **Download 300-DPI Map** for a print-ready PNG/JPEG (with embedded 300 DPI metadata), or download a **With & No Borders** pair in one step.
5. **Collaborate with Matthew** — Click **Save Project (.json)** or **Copy Share Link** to send your exact map framing and styling right back to Matthew.

---

## Option B: Running Local Python Pro Mode (`python run.py`)

When you want extra cartographic muscle on your own machine, running the local Python server upgrades the exact same studio UI with:
- **Contextily basemaps** (CartoDB Voyager, Positron, Esri World Shaded Relief, and Esri World Imagery)
- **Cartopy vector exports** (print-ready **PDF** and **SVG** alongside high-DPI PNG/JPEG)
- **Parallel multi-region batch exports** (download `.zip` packs with border pairs and JSON project sidecars)

### Setup & Launch

```bash
pip install -r requirements.txt
python run.py
```

Then open **`http://127.0.0.1:8000`** in your browser.

### Running the Test Suite

```bash
python -m unittest discover -s tests -v
```
