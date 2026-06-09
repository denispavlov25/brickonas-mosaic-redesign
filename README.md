# BRICKONAS Mosaic Configurator

A standalone web app that lets users turn any photo into a LEGO®-compatible brick mosaic, with live preview, color matching, and printable build instructions. Used in production at [brickonas.info/mosaik/](https://brickonas.info/mosaik/).

## Attribution

This project is a **derivative work** of [Lego Art Remix](https://github.com/debkbanerji/lego-art-remix) by [Deb Banerji](https://github.com/debkbanerji), originally published at [lego-art-remix.com](https://lego-art-remix.com/) under the [GNU GPL-3.0 license](LICENSE).

All credit for the original computer-vision algorithm, depth-map model integration (MiDaS via ONNX.js), color-matching logic, and PDF instruction generator goes to the original author.

**Forked / adapted:** February 2026.

## What's different from upstream

This fork adapts the original tool for the BRICKONAS brand and the German market:

- **German UI translations** (`js/i18n.js`) with `data-i18n` attributes throughout the interface
- **BRICKONAS branding** (logo, colors, header/footer styling)
- **Standalone deployment** as a self-contained static site (no build step), embedded in the WordPress site at `brickonas.info/mosaik/`
- **Minor UI/UX adjustments** for integration with the parent site's design system

The core algorithm, color science, depth-map worker, and instruction-generation logic are unchanged.

## License

This project is licensed under the **GNU General Public License v3.0** — same as the upstream project. See the [LICENSE](LICENSE) file for the full text.

If you redistribute, modify, or build on this code, you must:
- Make your source code available
- License derivative works under GPL-3.0
- Preserve copyright and license notices
- State that you modified the work

## Trademark notice

LEGO® is a registered trademark of the LEGO Group. The LEGO Group does not sponsor, authorize, or endorse this project or BRICKONAS. This tool is a fan-made utility for working with LEGO®-compatible building bricks.

## Running locally

This is a plain static web app — no build tools required.

```bash
# Serve from the repo root (any static server works)
python3 -m http.server 8000
# Open http://localhost:8000/
```

## Source code

- **This fork:** https://github.com/denispavlov25/brickonas-mosaic
- **Original upstream:** https://github.com/debkbanerji/lego-art-remix
