"""A small dedicated thread pool for voice analysis. Praat releases the GIL for its
heavy work, so this keeps the /realtime event loop free while bounding voice CPU
to two threads on the single 1-vCPU replica (and away from asyncio's shared
default pool used by e.g. the EEG combine export)."""
import asyncio
from concurrent.futures import ThreadPoolExecutor

_POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="voice")


async def run_voice(fn, *args):
    """Run a ciq.voice.features function in the voice pool."""
    return await asyncio.get_running_loop().run_in_executor(_POOL, fn, *args)
