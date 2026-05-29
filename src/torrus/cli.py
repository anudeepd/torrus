import logging
import os
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
@click.option("--ldap-config", "ldap_config", default=None,
              type=click.Path(exists=True, dir_okay=False, resolve_path=True),
              help="Path to ldapgate YAML config to enable LDAP authentication.")
@click.option("--ssl-keyfile", default=None, type=click.Path(exists=True, dir_okay=False),
              help="SSL key file for HTTPS")
@click.option("--ssl-certfile", default=None, type=click.Path(exists=True, dir_okay=False),
              help="SSL certificate file for HTTPS")
def serve(host, port, no_browser, reload, ldap_config, ssl_keyfile, ssl_certfile):
    """Start the torrus SSH web terminal."""
    if ldap_config:
        os.environ["TORRUS_LDAP_CONFIG"] = ldap_config
        click.echo(f"LDAP authentication enabled ({ldap_config})")

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-8s %(name)s %(message)s",
        datefmt="%H:%M:%S",
    )

    use_ssl = ssl_keyfile and ssl_certfile
    if not no_browser:
        browse_host = "127.0.0.1" if host == "0.0.0.0" else host
        scheme = "https" if use_ssl else "http"
        url = f"{scheme}://{browse_host}:{port}"
        threading.Timer(1.5, webbrowser.open, args=[url]).start()

    uvicorn.run(
        "torrus.server:app",
        host=host,
        port=port,
        reload=reload,
        log_level="info",
        ssl_keyfile=ssl_keyfile,
        ssl_certfile=ssl_certfile,
    )
