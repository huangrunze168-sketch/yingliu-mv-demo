import importlib.util
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SERVER_PATH = pathlib.Path(__file__).with_name("server.py")
SPEC = importlib.util.spec_from_file_location("yingliu_demo_server", SERVER_PATH)
assert SPEC and SPEC.loader
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


class ModelsNexusAdapterTests(unittest.TestCase):
    def test_http_error_exposes_status_and_submission_certainty(self) -> None:
        rejected = server.UpstreamHTTPError(400, "bad request", "request-400")
        unknown = server.UpstreamHTTPError(502, "bad gateway", "request-502")
        self.assertTrue(rejected.submission_is_definitively_rejected)
        self.assertFalse(unknown.submission_is_definitively_rejected)
        self.assertEqual(unknown.request_id, "request-502")

    def test_submit_marks_502_unknown_and_blocks_repeat(self) -> None:
        state = {"upstream_tasks": {}}

        def fake_read_state(_job_id: str):
            return state

        def fake_write_state(_job_id: str, **updates):
            state.update(updates)
            return state

        adapter = server.video_model_adapter("sd2.5海外版-480p")
        payload = adapter.build_payload("提示词", "16:9", 5, server.ModelReferences())
        upstream_error = server.UpstreamHTTPError(502, '{"code":"fail_to_fetch_task"}', "request-502")
        with patch.object(server, "read_state", side_effect=fake_read_state), \
             patch.object(server, "write_state", side_effect=fake_write_state), \
             patch.object(server, "api_json", side_effect=upstream_error):
            with self.assertRaises(server.UpstreamHTTPError):
                server.submit_video_task("job-1", "task-1", payload, "api-key", adapter)
            self.assertEqual(state["upstream_tasks"]["task-1"]["submission_state"], "unknown")
            self.assertEqual(state["submission_state"], "unknown")
            self.assertEqual(state["upstream_tasks"]["task-1"]["request_id"], "request-502")
            with self.assertRaisesRegex(RuntimeError, "不会再次提交"):
                server.submit_video_task("job-1", "task-1", payload, "api-key", adapter)

    def test_submit_marks_400_rejected_and_allows_explicit_retry(self) -> None:
        state = {"upstream_tasks": {}}

        def fake_read_state(_job_id: str):
            return state

        def fake_write_state(_job_id: str, **updates):
            state.update(updates)
            return state

        adapter = server.video_model_adapter("sd2.5海外版-480p")
        payload = adapter.build_payload("提示词", "16:9", 5, server.ModelReferences())
        responses = [server.UpstreamHTTPError(400, "bad request", "request-400"), {"id": "task-ok"}]
        with patch.object(server, "read_state", side_effect=fake_read_state), \
             patch.object(server, "write_state", side_effect=fake_write_state), \
             patch.object(server, "api_json", side_effect=responses):
            with self.assertRaises(server.UpstreamHTTPError):
                server.submit_video_task("job-1", "task-1", payload, "api-key", adapter)
            self.assertEqual(state["upstream_tasks"]["task-1"]["submission_state"], "rejected")
            self.assertEqual(server.submit_video_task("job-1", "task-1", payload, "api-key", adapter), "task-ok")

    def test_reference_builder_only_returns_typed_urls(self) -> None:
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
                references = server.build_model_references("job-1", directory, files)

        self.assertEqual(references.images, (
            "https://assets.example/portrait", "https://assets.example/portrait_2",
        ))
        self.assertEqual(references.videos, ("https://assets.example/reference",))
        self.assertEqual(references.audios, (
            "https://assets.example/voice", "https://assets.example/reference_audio",
            "https://assets.example/song",
        ))

    def test_media_upload_waits_for_ready_even_when_processing_has_uri(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            media = directory / "portrait.png"
            media.write_bytes(b"image")
            state = {"media_assets": {}}

            def fake_read_state(_job_id: str):
                return state

            def fake_write_state(_job_id: str, **updates):
                state.update(updates)
                return state

            responses = [
                {"id": "asset-1", "status": "processing", "uri": "asset://asset-1"},
                {"id": "asset-1", "status": "ready", "uri": "asset://asset-1"},
            ]
            with patch.object(server, "read_state", side_effect=fake_read_state), \
                 patch.object(server, "write_state", side_effect=fake_write_state), \
                 patch.object(server, "api_json", side_effect=responses), \
                 patch.object(server.time, "sleep"):
                uri = server.upload_seedance_asset("job-1", "portrait", media, "sd2.5海外版-480p")

        self.assertEqual(uri, "asset://asset-1")
        self.assertEqual(state["media_assets"]["portrait"]["status"], "ready")

    def test_media_upload_resumes_existing_asset_without_uploading_again(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            media = pathlib.Path(temporary) / "portrait.png"
            media.write_bytes(b"image")
            state = {"media_assets": {"portrait": {
                "submission_state": "submitted", "type": "image", "filename": media.name,
                "id": "asset-1", "status": "processing", "uri": "asset://asset-1",
            }}}

            with patch.object(server, "read_state", return_value=state), \
                 patch.object(server, "write_state", side_effect=lambda _job_id, **updates: state.update(updates)), \
                 patch.object(server, "api_json", return_value={
                     "id": "asset-1", "status": "ready", "uri": "asset://asset-1",
                 }) as api_json, \
                 patch.object(server, "encode_multipart") as encode_multipart, \
                 patch.object(server.time, "sleep"):
                uri = server.upload_seedance_asset("job-1", "portrait", media, "sd2.5海外版-480p")

        self.assertEqual(uri, "asset://asset-1")
        self.assertEqual(api_json.call_count, 1)
        encode_multipart.assert_not_called()

    def test_each_supported_model_has_its_own_adapter_instance(self) -> None:
        expected_classes = {
            "sd2.0海外版-480p": server.Seedance20Overseas480Adapter,
            "sd2.0海外版-720p": server.Seedance20Overseas720Adapter,
            "sd2.5海外版-480p": server.Seedance25Overseas480Adapter,
            "sd2.5海外版-720p": server.Seedance25Overseas720Adapter,
            "minimax-h3-768p": server.MiniMaxH3768Adapter,
            "minimax-h3-2k": server.MiniMaxH32KAdapter,
        }
        self.assertEqual(set(server.VIDEO_MODEL_ADAPTERS), set(expected_classes))
        for model, adapter_class in expected_classes.items():
            self.assertIsInstance(server.VIDEO_MODEL_ADAPTERS[model], adapter_class)

    def test_seedance_25_payload_matches_its_documented_template(self) -> None:
        adapter = server.video_model_adapter("sd2.5海外版-720p")
        references = server.ModelReferences(
            ("https://assets.example/person.png",),
            ("https://assets.example/reference.mp4",),
            ("https://assets.example/song.wav",),
        )
        payload = adapter.build_payload("提示词", "16:9", 30, references)
        self.assertEqual(payload, {
            "model": "sd2.5海外版-720p",
            "prompt": "提示词",
            "duration": 30,
            "ratio": "16:9",
            "resolution": "720p",
            "generate_audio": True,
            "referenceImages": ["https://assets.example/person.png"],
            "referenceVideos": ["https://assets.example/reference.mp4"],
            "referenceAudios": ["https://assets.example/song.wav"],
            "omni_reference_task_type": "reference",
        })
        for forbidden in ("content", "output_format", "mode", "seconds", "aspect_ratio"):
            self.assertNotIn(forbidden, payload)

    def test_minimax_payload_uses_its_own_template(self) -> None:
        adapter = server.video_model_adapter("minimax-h3-2k")
        references = server.ModelReferences(
            ("https://assets.example/person.png",), (), ("https://assets.example/song.wav",),
        )
        payload = adapter.build_payload("提示词", "9:16", 15, references)
        self.assertEqual(payload, {
            "model": "minimax-h3-2k", "prompt": "提示词", "duration": 15, "ratio": "9:16",
            "generate_audio": True,
            "referenceImages": ["https://assets.example/person.png"],
            "referenceAudios": ["https://assets.example/song.wav"],
        })
        for forbidden in ("content", "seconds", "metadata", "images", "input_reference",
                          "omni_reference_task_type", "output_format", "resolution", "watermark"):
            self.assertNotIn(forbidden, payload)

    def test_seedance_and_minimax_templates_cannot_leak_into_each_other(self) -> None:
        empty = server.ModelReferences()
        seedance = server.video_model_adapter("sd2.0海外版-480p").build_payload("p", "1:1", 5, empty)
        minimax = server.video_model_adapter("minimax-h3-768p").build_payload("p", "1:1", 4, empty)
        self.assertEqual(seedance["resolution"], "480p")
        self.assertNotIn("resolution", minimax)
        self.assertNotIn("omni_reference_task_type", minimax)

    def test_adapter_unwraps_data_envelope_and_reads_download_url(self) -> None:
        adapter = server.video_model_adapter("sd2.5海外版-480p")
        response = {"data": {"id": "task-1", "status": "completed", "progress": "100%",
                             "download_url": "https://cdn.example/result.mp4"}}
        self.assertEqual(adapter.task_id(response), "task-1")
        self.assertEqual(adapter.status(response), ("completed", "100%"))
        self.assertEqual(adapter.download_url(response), "https://cdn.example/result.mp4")

    def test_duration_limits_are_model_specific(self) -> None:
        server.video_model_adapter("sd2.5海外版-480p").validate("16:9", 30)
        with self.assertRaises(ValueError):
            server.video_model_adapter("sd2.0海外版-480p").validate("16:9", 30)
        with self.assertRaises(ValueError):
            server.video_model_adapter("minimax-h3-2k").validate("16:9", 16)

    def test_seedance_uses_documented_poll_interval(self) -> None:
        self.assertEqual(server.video_model_adapter("sd2.5海外版-480p").poll_interval_seconds, 30)
        self.assertEqual(server.video_model_adapter("minimax-h3-768p").poll_interval_seconds, 5)

    def test_model_aliases_are_strict(self) -> None:
        for model in (*server.SEEDANCE_MODEL_SPECS, *server.MINIMAX_MODEL_SPECS):
            self.assertEqual(server.upstream_model_name({"model": model}), model)
        with self.assertRaises(ValueError):
            server.upstream_model_name({"model": "Seedance 2.5"})

    def test_reference_video_is_normalized_to_even_h264_mp4(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            source = directory / "reference.mkv"
            subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
                "-i", "testsrc=size=641x359:rate=25", "-t", "0.5", "-c:v", "ffv1", str(source),
            ], check=True, capture_output=True, timeout=30)
            files = {"reference": source.name}

            server.normalize_reference_video(directory, files)

            output = directory / files["reference"]
            probe = subprocess.run([
                "ffprobe", "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=codec_name,width,height,pix_fmt", "-of", "json", str(output),
            ], check=True, capture_output=True, text=True, timeout=30)
            details = __import__("json").loads(probe.stdout)["streams"][0]
            self.assertEqual(details["codec_name"], "h264")
            self.assertEqual(details["pix_fmt"], "yuv420p")
            self.assertEqual(details["width"] % 2, 0)
            self.assertEqual(details["height"] % 2, 0)


if __name__ == "__main__":
    unittest.main()
