# Artifact Store

Shared persistence for workflow evidence and reusable cache data. Run artifacts
are written below `data/runs/<run_id>` with an atomic manifest. Cache entries are
stored separately below `data/cache` and never advance workflow state.
