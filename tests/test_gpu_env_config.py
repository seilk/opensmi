import unittest

from opensmi.models import GPUEnvConfig


class TestGPUEnvConfig(unittest.TestCase):
    def test_auto_generate_cuda_visible_devices(self):
        config = GPUEnvConfig(gpu_indices=[0, 1, 2])
        self.assertEqual(config.cuda_visible_devices, "0,1,2")

    def test_explicit_cuda_visible_devices(self):
        config = GPUEnvConfig(gpu_indices=[0, 1], cuda_visible_devices="custom_value")
        self.assertEqual(config.cuda_visible_devices, "custom_value")

    def test_empty_gpu_indices(self):
        config = GPUEnvConfig(gpu_indices=[])
        self.assertIsNone(config.cuda_visible_devices)

    def test_to_env_dict_basic(self):
        config = GPUEnvConfig(gpu_indices=[0, 1])
        env = config.to_env_dict()
        self.assertEqual(env, {"CUDA_VISIBLE_DEVICES": "0,1"})

    def test_to_env_dict_with_additional_env(self):
        config = GPUEnvConfig(
            gpu_indices=[3], additional_env={"MY_VAR": "value", "ANOTHER": "test"}
        )
        env = config.to_env_dict()
        self.assertEqual(
            env,
            {"CUDA_VISIBLE_DEVICES": "3", "MY_VAR": "value", "ANOTHER": "test"},
        )

    def test_to_env_dict_no_cuda_visible_devices(self):
        config = GPUEnvConfig(gpu_indices=[], additional_env={"CUSTOM": "var"})
        env = config.to_env_dict()
        self.assertEqual(env, {"CUSTOM": "var"})

    def test_single_gpu(self):
        config = GPUEnvConfig(gpu_indices=[7])
        self.assertEqual(config.cuda_visible_devices, "7")
        self.assertEqual(config.to_env_dict(), {"CUDA_VISIBLE_DEVICES": "7"})


if __name__ == "__main__":
    unittest.main()
