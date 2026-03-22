import logging
import threading
import webbrowser

import click
import uvicorn


@click.group()
def main():
    """torrus — web-based SSH terminal."""
    pass


@main.command()
@click.option("--host", default="127.0.0.1", show_default=True, help="Bind host")
@click.option("--port", default=8080, show_default=True, help="Bind port")
@click.option("--no-browser", is_flag=True, default=False, help="Don't open browser on startup")
@click.option("--reload", is_flag=True, default=False, hidden=True, help="Dev auto-reload")
def serve(host, port, no_browser, reload):
    """Start the torrus SSH web terminal."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-8s %(name)s %(message)s",
        datefmt="%H:%M:%S",
    )

    if not no_browser:
        browse_host = "127.0.0.1" if host == "0.0.0.0" else host
        url = f"http://{browse_host}:{port}"
        # Open after a short delay so uvicorn has time to bind
        threading.Timer(1.5, webbrowser.open, args=[url]).start()

    uvicorn.run(
        "torrus.server:app",
        host=host,
        port=port,
        reload=reload,
        log_level="info",
    )
