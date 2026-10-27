import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch


SERVER_PATH = pathlib.Path(__file__).with_name("server.py")
SPEC = importlib.util.spec_from_file_location("yingliu_demo_server", SERVER_PATH)
assert SPEC and SPEC.loader
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


class ModelsNexusAdapterTests(unittest.TestCase):
    def test_content_uses_all_supported_materials_as_peers(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            files = {"portrait": "portrait.png", "portrait_2": "portrait-2.png",
                     "reference": "reference.mp4", "voice": "voice.wav",
                     "reference_audio": "reference-audio.wav", "song": "song.wav"}
            for filename in files.values():
                (directory / filename).write_bytes(b"test")

            def fake_url(job_id: str, key: str, path: pathlib.Path) -> str:
                self.assertEqual(job_id, "job-1")
                self.assertTrue(path.is_file())
                return f"https://assets.example/{key}"

            with patch.object(server, "create_signed_asset_url", side_effect=fake_url):
                content = server.build_models_nexus_content("job-1", directory, files, "完整提示词")

        self.assertEqual(content[0], {"type": "text", "text": "完整提示词"})
        self.assertEqual([item["role"] for item in content[1:]], [
            "reference_image", "reference_image", "reference_video",
            "reference_audio", "reference_audio", "reference_audio",
        ])
        self.assertEqual(len(content), 7)

    def test_seedance_payload_contains_only_documented_fields(self) -> None:
        content = [{"type": "text", "text": "提示词"}]
        payload = server.seedance_payload(
            "sd2.5海外版-720p", server.SEEDANCE_MODEL_SPECS["sd2.5海外版-720p"],
            "16:9", 30, content,
        )
        self.assertEqual(set(payload), {"model", "content", "duration", "ratio", "generate_audio", "mode"})
        self.assertEqual(payload["content"], content)
        self.assertNotIn("prompt", payload)
        self.assertNotIn("output_format", payload)
        self.assertNotIn("resolution", payload)
        self.assertEqual(payload["mode"], "reference")

    def test_minimax_payload_does_not_use_legacy_compatibility_fields(self) -> None:
        content = [{"type": "text", "text": "提示词"}]
        payload = server.minimax_payload(
            "minimax-h3-2k", server.MINIMAX_MODEL_SPECS["minimax-h3-2k"],
            "9:16", 15, content,
        )
        self.assertEqual(payload, {
            "model": "minimax-h3-2k", "content": content, "duration": 15, "ratio": "9:16",
        })
        for forbidden in ("prompt", "seconds", "metadata", "images", "input_reference",
                          "referenceImages", "output_format", "resolution", "watermark"):
            self.assertNotIn(forbidden, payload)

    def test_model_aliases_are_strict(self) -> None:
        for model in (*server.SEEDANCE_MODEL_SPECS, *server.MINIMAX_MODEL_SPECS):
            self.assertEqual(server.upstream_model_name({"model": model}), model)
        with self.assertRaises(ValueError):
            server.upstream_model_name({"model": "Seedance 2.5"})


if __name__ == "__main__":
    unittest.main()
