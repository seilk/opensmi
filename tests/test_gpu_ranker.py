from opensmi.gpu_ranker import rank_gpus, select_top_gpus, _get_last_used
from opensmi.models import ClusterSnapshot, NodeSnapshot, GPUInfo, GPUProcess


def test_rank_gpus_never_used_priority():
    gpus = [
        GPUInfo(index=0, uuid="gpu-0", name="GPU0", utilization_gpu_percent=50),
        GPUInfo(index=1, uuid="gpu-1", name="GPU1", utilization_gpu_percent=10),
    ]
    procs = [GPUProcess(gpu_uuid="gpu-0", pid=100, process_name="proc", user="user1")]
    node = NodeSnapshot(node_alias="n1", address="n1", gpus=gpus, processes=procs)
    snap = ClusterSnapshot(
        cluster_name="test", timestamp="2025-01-01T00:00:00Z", nodes=[node]
    )

    history = {"n1": {0: "2025-01-01T00:00:00Z"}}

    ranked = rank_gpus(snap, history)

    assert len(ranked) == 2
    assert ranked[0][1] == 1
    assert ranked[1][1] == 0


def test_rank_gpus_process_count_tiebreaker():
    gpus = [
        GPUInfo(index=0, uuid="gpu-0", name="GPU0", utilization_gpu_percent=50),
        GPUInfo(index=1, uuid="gpu-1", name="GPU1", utilization_gpu_percent=50),
    ]
    procs = [
        GPUProcess(gpu_uuid="gpu-0", pid=100, process_name="proc1", user="user1"),
        GPUProcess(gpu_uuid="gpu-0", pid=101, process_name="proc2", user="user1"),
        GPUProcess(gpu_uuid="gpu-1", pid=102, process_name="proc3", user="user2"),
    ]
    node = NodeSnapshot(node_alias="n1", address="n1", gpus=gpus, processes=procs)
    snap = ClusterSnapshot(
        cluster_name="test", timestamp="2025-01-01T00:00:00Z", nodes=[node]
    )

    ranked = rank_gpus(snap, {})

    assert ranked[0][1] == 1
    assert ranked[1][1] == 0


def test_rank_gpus_utilization_tiebreaker():
    gpus = [
        GPUInfo(index=0, uuid="gpu-0", name="GPU0", utilization_gpu_percent=80),
        GPUInfo(index=1, uuid="gpu-1", name="GPU1", utilization_gpu_percent=20),
    ]
    node = NodeSnapshot(node_alias="n1", address="n1", gpus=gpus, processes=[])
    snap = ClusterSnapshot(
        cluster_name="test", timestamp="2025-01-01T00:00:00Z", nodes=[node]
    )

    ranked = rank_gpus(snap, {})

    assert ranked[0][1] == 1
    assert ranked[1][1] == 0


def test_rank_gpus_index_final_tiebreaker():
    gpus = [
        GPUInfo(index=2, uuid="gpu-2", name="GPU2", utilization_gpu_percent=50),
        GPUInfo(index=0, uuid="gpu-0", name="GPU0", utilization_gpu_percent=50),
        GPUInfo(index=1, uuid="gpu-1", name="GPU1", utilization_gpu_percent=50),
    ]
    node = NodeSnapshot(node_alias="n1", address="n1", gpus=gpus, processes=[])
    snap = ClusterSnapshot(
        cluster_name="test", timestamp="2025-01-01T00:00:00Z", nodes=[node]
    )

    ranked = rank_gpus(snap, {})

    assert ranked[0][1] == 0
    assert ranked[1][1] == 1
    assert ranked[2][1] == 2


def test_rank_gpus_skip_error_nodes():
    node_ok = NodeSnapshot(
        node_alias="n1",
        address="n1",
        gpus=[GPUInfo(index=0, uuid="gpu-0", name="GPU0", utilization_gpu_percent=50)],
        processes=[],
    )
    node_err = NodeSnapshot(
        node_alias="n2",
        address="n2",
        error="Connection failed",
        gpus=[],
        processes=[],
    )
    snap = ClusterSnapshot(
        cluster_name="test", timestamp="2025-01-01T00:00:00Z", nodes=[node_ok, node_err]
    )

    ranked = rank_gpus(snap, {})

    assert len(ranked) == 1
    assert ranked[0][0] == "n1"


def test_select_top_gpus():
    gpus = [
        GPUInfo(
            index=i, uuid=f"gpu-{i}", name=f"GPU{i}", utilization_gpu_percent=i * 10
        )
        for i in range(5)
    ]
    node = NodeSnapshot(node_alias="n1", address="n1", gpus=gpus, processes=[])
    snap = ClusterSnapshot(
        cluster_name="test", timestamp="2025-01-01T00:00:00Z", nodes=[node]
    )

    top3 = select_top_gpus(snap, 3, {})

    assert len(top3) == 3
    assert top3[0] == ("n1", 0)
    assert top3[1] == ("n1", 1)
    assert top3[2] == ("n1", 2)


def test_get_last_used():
    history = {"n1": {0: "2025-01-01T00:00:00Z", 1: "2025-01-02T00:00:00Z"}}

    assert _get_last_used(history, "n1", 0) == "2025-01-01T00:00:00Z"
    assert _get_last_used(history, "n1", 1) == "2025-01-02T00:00:00Z"
    assert _get_last_used(history, "n1", 2) == ""
    assert _get_last_used(history, "n2", 0) == ""
