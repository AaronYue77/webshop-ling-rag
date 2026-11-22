import base64
import hashlib
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"


def inline_page():
    page = (WEB / "index.html").read_text(encoding="utf-8")
    def embed_guide_image(match):
        file = WEB / match[1]
        encoded = base64.b64encode(file.read_bytes()).decode("ascii")
        return 'src="data:image/png;base64,' + encoded + '"'

    page = re.sub(r'src="(kaggle-guide/[a-z0-9-]+\.png)"', embed_guide_image, page)
    scripts = []
    for name in ("policy.js", "catalog.js", "rag.js", "app.js"):
        source = re.sub(r"</script", lambda m: r"<\/" + m[0][2:], (WEB / name).read_text(encoding="utf-8"), flags=re.I)
        scripts.append(source)
        page = page.replace('  <script defer src="' + name + '"></script>\n', "")
    css = (WEB / "style.css").read_text(encoding="utf-8")
    page = page.replace('<link rel="stylesheet" href="style.css">', "<style>" + css + "</style>")
    page = page.replace("</body>", "".join("<script>" + source + "</script>\n" for source in scripts) + "</body>")

    def csp_hash(text):
        return "'sha256-" + base64.b64encode(hashlib.sha256(text.encode("utf-8")).digest()).decode("ascii") + "'"

    page = page.replace("script-src 'self' file:", "script-src " + " ".join(csp_hash(x) for x in scripts))
    return page.replace("style-src 'self' file:", "style-src " + csp_hash(css))


def main(dest):
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "WebShop.html").write_text(inline_page(), encoding="utf-8", newline="\n")
    print(dest / "WebShop.html")


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT)
