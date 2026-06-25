import logging

from torrus.logging_utils import RoutinePollingAccessFilter, suppress_routine_polling_logs


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

        installed = [f for f in logger.filters if isinstance(f, RoutinePollingAccessFilter)]
        assert len(installed) == 1
    finally:
        logger.filters[:] = original_filters
