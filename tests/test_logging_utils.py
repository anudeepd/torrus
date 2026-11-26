import logging

from torrus.logging_utils import (
    RoutinePollingAccessFilter,
    configure_logging,
    suppress_routine_polling_logs,
)


def _access_record(path: str, status_code: int) -> logging.LogRecord:
    return logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg='%s - "%s %s HTTP/%s" %s',
        args=("127.0.0.1:12345", "GET", path, "1.1", status_code),
        exc_info=None,
    )


def test_successful_socketio_polling_access_logs_are_suppressed():
    filt = RoutinePollingAccessFilter()

    record = _access_record("/socket.io/?EIO=4&transport=polling&t=abc", 200)

    assert not filt.filter(record)


def test_failed_socketio_polling_access_logs_are_kept():
    filt = RoutinePollingAccessFilter()

    record = _access_record("/socket.io/?EIO=4&transport=polling&t=abc", 500)

    assert filt.filter(record)


def test_non_polling_access_logs_are_kept():
    filt = RoutinePollingAccessFilter()

    record = _access_record("/api/config", 200)

    assert filt.filter(record)


def test_polling_filter_is_installed_once():
    logger = logging.getLogger("uvicorn.access")
    original_filters = list(logger.filters)
    logger.filters.clear()
    try:
        suppress_routine_polling_logs()
        suppress_routine_polling_logs()

        installed = [
            f for f in logger.filters if isinstance(f, RoutinePollingAccessFilter)
        ]
        assert len(installed) == 1
    finally:
        logger.filters[:] = original_filters


def test_configure_logging_adds_a_file_handler(tmp_path):
    log_file = tmp_path / "nested" / "torrus.log"
    root = logging.getLogger()
    original = list(root.handlers)
    root.handlers.clear()
    try:
        configure_logging(log_file)
        assert log_file.parent.is_dir()
        assert any(
            isinstance(handler, logging.FileHandler)
            and handler.baseFilename == str(log_file)
            for handler in root.handlers
        )
    finally:
        for handler in root.handlers:
            if handler not in original:
                handler.close()
        root.handlers[:] = original


def test_filter_keeps_unrelated_loggers_and_unparseable_records():
    filt = RoutinePollingAccessFilter()

    unrelated = logging.LogRecord("torrus.server", logging.INFO, __file__, 1, "x", None, None)
    assert filt.filter(unrelated) is True

    no_path = logging.LogRecord(
        "uvicorn.access", logging.INFO, __file__, 1, "plain message", None, None
    )
    assert filt.filter(no_path) is True


def test_filter_reads_dict_args_and_falls_back_to_the_message():
    filt = RoutinePollingAccessFilter()

    dict_record = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        1,
        "%(full_path)s",
        {"full_path": "/socket.io/?transport=polling", "status_code": "200"},
        None,
    )
    assert filt.filter(dict_record) is False

    path_first = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        1,
        "%(path)s",
        {"path": "/api/config", "status_code": 200},
        None,
    )
    assert filt.filter(path_first) is True

    message_record = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        1,
        'client - "GET /socket.io/?transport=polling HTTP/1.1" 503',
        None,
        None,
    )
    assert filt.filter(message_record) is False

    malformed = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        1,
        "%s",
        ("client", "GET", "/socket.io/?transport=polling", "1.1", "bad"),
        None,
    )
    assert filt.filter(malformed) is False


def test_filter_handles_dict_status_failures():
    filt = RoutinePollingAccessFilter()
    record = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        1,
        "%(path)s",
        {"path": "/socket.io/?transport=polling", "status_code": object()},
        None,
    )
    assert filt.filter(record) is False


def test_filter_ignores_non_string_structured_paths():
    record = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        1,
        "%(path)s",
        {"path": 123, "status_code": 200},
        None,
    )

    assert RoutinePollingAccessFilter().filter(record) is True
