"use client";

import {
	AlertCircle,
	Clock,
	Disc3,
	Download,
	FileJson,
	FileText,
	ListMusic,
	Loader2,
	Music,
	Pause,
	Play,
	SkipBack,
	SkipForward,
	Volume2,
	VolumeX,
} from "lucide-react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/utils/cn";
import { formatTime } from "@/utils/formatTime";

interface AlbumTrackResource {
	id: string;
	title: string;
	duration: number;
	trackNo: number;
	discNo: number;
	album: {
		title: string;
		artist: {
			id: string;
			name: string;
		};
	};
}

interface AlbumResource {
	id: string;
	title: string;
	coverArt?: string | null;
	coverUrl?: string | null;
	artist: {
		id: string;
		name: string;
		mbid?: string;
	};
	tracks: AlbumTrackResource[];
}

interface TrackResource {
	id: string;
	title: string;
	duration: number;
	album: {
		id: string;
		title: string;
		coverArt?: string | null;
		coverUrl?: string | null;
		artist: {
			id: string;
			name: string;
		};
	};
}

interface PlaylistItemResource {
	id: string;
	sort: number;
	track: {
		id: string;
		title: string;
		duration: number;
		album: {
			title: string;
			coverArt?: string | null;
			coverUrl?: string | null;
			artist: {
				id: string;
				name: string;
			};
		};
	} | null;
	trackTidal: unknown | null;
	trackYtMusic: unknown | null;
}

interface PlaylistResource {
	id: string;
	name: string;
	user?: {
		username: string;
	};
	items: PlaylistItemResource[];
}

interface ShareResponse {
	resourceType: "album" | "track" | "playlist";
	resource: AlbumResource | TrackResource | PlaylistResource;
}

interface PlayableTrack {
	id: string;
	title: string;
	artist: string;
	coverUrl: string | null;
	duration: number;
}

function buildJsonExport(name: string, tracks: PlayableTrack[]): string {
	return JSON.stringify(
		{
			name,
			exportedAt: new Date().toISOString(),
			source: "soundspan",
			tracks: tracks.map((track) => ({
				title: track.title,
				artist: track.artist,
				duration: track.duration,
			})),
		},
		null,
		2,
	);
}

function buildM3uExport(name: string, tracks: PlayableTrack[]): string {
	const lines = ["#EXTM3U", `#PLAYLIST:${name}`];
	for (const track of tracks) {
		lines.push(
			`#EXTINF:${Math.round(track.duration)},${track.artist} - ${track.title}`,
		);
		lines.push(track.title);
	}
	return lines.join("\n");
}

function downloadBlob(content: string, filename: string, mimeType: string) {
	const blob = new Blob([content], { type: mimeType });
	const blobUrl = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = blobUrl;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
	URL.revokeObjectURL(blobUrl);
}

function sanitizeFilename(value: string): string {
	return value.replace(/[\\/:*?"<>|]/g, "_").trim() || "playlist";
}

/** Renders the SharePage component. */
export default function SharePage() {
	const params = useParams<{ token: string | string[] }>();
	const token = Array.isArray(params.token) ? params.token[0] : params.token;

	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(false);
	const [data, setData] = useState<ShareResponse | null>(null);

	const [currentTrack, setCurrentTrack] = useState<PlayableTrack | null>(null);
	const [isPlaying, setIsPlaying] = useState(false);
	const [progress, setProgress] = useState(0);
	const [duration, setDuration] = useState(0);
	const [volume, setVolume] = useState(1);
	const [isMuted, setIsMuted] = useState(false);
	const audioRef = useRef<HTMLAudioElement>(null);

	const getCoverUrl = useCallback(
		(rawUrl: string | null | undefined): string | null => {
			if (!token || !rawUrl) {
				return null;
			}
			return `/api/share-links/access/${token}/cover?url=${encodeURIComponent(rawUrl)}`;
		},
		[token],
	);

	const getStreamUrl = useCallback(
		(trackId: string): string => `/api/share-links/access/${token}/stream/${trackId}`,
		[token],
	);

	const getDownloadUrl = useCallback(
		(trackId: string): string =>
			`/api/share-links/access/${token}/stream/${trackId}?download=true`,
		[token],
	);

	const playlistSortedItems = useMemo(() => {
		if (!data || data.resourceType !== "playlist") {
			return [] as PlaylistItemResource[];
		}
		const playlist = data.resource as PlaylistResource;
		return [...playlist.items].sort((a, b) => a.sort - b.sort);
	}, [data]);

	const playlistFilteredItems = useMemo(
		() => playlistSortedItems.filter((item) => item.track !== null),
		[playlistSortedItems],
	);

	const trackQueue = useMemo<PlayableTrack[]>(() => {
		if (!data) {
			return [];
		}

		if (data.resourceType === "album") {
			const album = data.resource as AlbumResource;
			const coverUrl = getCoverUrl(album.coverUrl || album.coverArt);
			return album.tracks.map((track) => ({
				id: track.id,
				title: track.title,
				artist: album.artist.name,
				coverUrl,
				duration: track.duration,
			}));
		}

		if (data.resourceType === "playlist") {
			return playlistFilteredItems.map((item) => ({
				id: item.track.id,
				title: item.track.title,
				artist: item.track.album.artist.name,
				coverUrl: getCoverUrl(
					item.track.album.coverUrl || item.track.album.coverArt,
				),
				duration: item.track.duration,
			}));
		}

		const track = data.resource as TrackResource;
		return [
			{
				id: track.id,
				title: track.title,
				artist: track.album.artist.name,
				coverUrl: getCoverUrl(track.album.coverUrl || track.album.coverArt),
				duration: track.duration,
			},
		];
	}, [data, getCoverUrl, playlistFilteredItems]);

	const currentTrackIndex = useMemo(
		() => trackQueue.findIndex((track) => track.id === currentTrack?.id),
		[trackQueue, currentTrack],
	);

	const hasPrev = currentTrackIndex > 0;
	const hasNext =
		currentTrackIndex >= 0 && currentTrackIndex < trackQueue.length - 1;

	const playTrack = useCallback(
		(track: PlayableTrack) => {
			const audio = audioRef.current;
			if (!audio) {
				return;
			}

			if (currentTrack?.id === track.id) {
				if (audio.paused) {
					void audio.play().catch(() => undefined);
				} else {
					audio.pause();
				}
				return;
			}

			setCurrentTrack(track);
			setProgress(0);
			setDuration(track.duration);
		},
		[currentTrack],
	);

	const handlePlayPause = useCallback(() => {
		const audio = audioRef.current;
		if (!audio || !currentTrack) {
			return;
		}

		if (audio.paused) {
			void audio.play().catch(() => undefined);
		} else {
			audio.pause();
		}
	}, [currentTrack]);

	const handleNext = useCallback(() => {
		if (!hasNext || currentTrackIndex < 0) {
			setIsPlaying(false);
			return;
		}
		const nextTrack = trackQueue[currentTrackIndex + 1];
		if (nextTrack) {
			setCurrentTrack(nextTrack);
			setProgress(0);
			setDuration(nextTrack.duration);
		}
	}, [currentTrackIndex, hasNext, trackQueue]);

	const handlePrev = useCallback(() => {
		const audio = audioRef.current;
		if (!audio) {
			return;
		}

		if (audio.currentTime > 3) {
			audio.currentTime = 0;
			setProgress(0);
			return;
		}

		if (!hasPrev || currentTrackIndex < 0) {
			return;
		}

		const prevTrack = trackQueue[currentTrackIndex - 1];
		if (prevTrack) {
			setCurrentTrack(prevTrack);
			setProgress(0);
			setDuration(prevTrack.duration);
		}
	}, [currentTrackIndex, hasPrev, trackQueue]);

	const handleSeek = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
		const audio = audioRef.current;
		if (!audio || !duration) {
			return;
		}
		const rect = event.currentTarget.getBoundingClientRect();
		const clickX = event.clientX - rect.left;
		const ratio = Math.max(0, Math.min(1, clickX / rect.width));
		const seekTime = ratio * duration;
		audio.currentTime = seekTime;
		setProgress(seekTime);
	}, [duration]);

	const handleVolumeChange = useCallback(
		(event: React.ChangeEvent<HTMLInputElement>) => {
			const nextVolume = Number(event.target.value);
			setVolume(nextVolume);
			setIsMuted(nextVolume === 0);
		},
		[],
	);

	const toggleMute = useCallback(() => {
		setIsMuted((previous) => !previous);
	}, []);

	const handleDownloadAll = useCallback(() => {
		for (const [index, track] of trackQueue.entries()) {
			window.setTimeout(() => {
				const link = document.createElement("a");
				link.href = getDownloadUrl(track.id);
				link.download = `${sanitizeFilename(track.artist)} - ${sanitizeFilename(track.title)}.mp3`;
				document.body.appendChild(link);
				link.click();
				document.body.removeChild(link);
			}, index * 500);
		}
	}, [getDownloadUrl, trackQueue]);

	useEffect(() => {
		let cancelled = false;

		const load = async () => {
			if (!token) {
				if (!cancelled) {
					setError(true);
					setLoading(false);
				}
				return;
			}

			try {
				setLoading(true);
				setError(false);
				const response = await fetch(`/api/share-links/access/${token}`);
				if (!response.ok) {
					throw new Error("Not found");
				}
				const json = (await response.json()) as ShareResponse;
				if (!cancelled) {
					setData(json);
				}
			} catch {
				if (!cancelled) {
					setError(true);
					setData(null);
				}
			} finally {
				if (!cancelled) {
					setLoading(false);
				}
			}
		};

		void load();

		return () => {
			cancelled = true;
		};
	}, [token]);

	useEffect(() => {
		const audio = audioRef.current;
		if (!audio || !currentTrack) {
			return;
		}
		audio.load();
		void audio.play().catch(() => undefined);
	}, [currentTrack]);

	useEffect(() => {
		const audio = audioRef.current;
		if (!audio) {
			return;
		}
		audio.volume = isMuted ? 0 : volume;
		audio.muted = isMuted;
	}, [isMuted, volume]);

	useEffect(() => {
		if (!trackQueue.length) {
			setCurrentTrack(null);
			setIsPlaying(false);
			setProgress(0);
			setDuration(0);
			return;
		}

		if (currentTrack && trackQueue.some((track) => track.id === currentTrack.id)) {
			return;
		}

		setCurrentTrack(null);
		setIsPlaying(false);
		setProgress(0);
		setDuration(0);
	}, [currentTrack, trackQueue]);

	if (loading) {
		return (
			<main className="flex min-h-screen items-center justify-center bg-[#0a0a0a] px-4 text-white">
				<div className="flex items-center gap-3 text-gray-300">
					<Loader2 className="h-5 w-5 animate-spin text-[#3b82f6]" />
					<span>Loading shared link...</span>
				</div>
			</main>
		);
	}

	if (error || !data) {
		return (
			<main className="flex min-h-screen items-center justify-center bg-[#0a0a0a] px-4 text-white">
				<div className="w-full max-w-2xl rounded-xl border border-[#262626] bg-[#111111]/60 p-8 text-center">
					<div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-red-500/30 bg-red-500/10">
						<AlertCircle className="h-7 w-7 text-red-400" />
					</div>
					<h1 className="text-2xl font-semibold">Link not found or expired</h1>
					<p className="mt-2 text-sm text-gray-400">
						This share link is invalid, expired, or no longer available.
					</p>
					<p className="mt-8 text-xs text-gray-600">soundspan™</p>
				</div>
			</main>
		);
	}

	const renderCover = (cover: string | null) => (
		<div className="h-40 w-40 shrink-0 overflow-hidden rounded-xl border border-[#262626] bg-[#0a0a0a]">
			{cover ? (
				<img src={cover} alt="Cover art" className="h-full w-full object-cover" />
			) : (
				<div className="flex h-full w-full items-center justify-center text-gray-500">
					<Music className="h-14 w-14" />
				</div>
			)}
		</div>
	);

	const renderTrackRow = (
		track: PlayableTrack,
		positionLabel: string,
		index: number,
		total: number,
		showArtist: boolean,
	) => {
		const isActive = currentTrack?.id === track.id;
		return (
			<button
				type="button"
				key={track.id}
				onClick={() => playTrack(track)}
				className={cn(
					"group relative grid w-full grid-cols-[40px_1fr_auto_auto] items-center gap-3 px-4 py-3 text-left transition-colors",
					"cursor-pointer hover:bg-white/5",
					index !== total - 1 && "border-b border-[#262626]",
					isActive && "bg-white/5 border-l-2 border-l-[#3b82f6] pl-[14px]",
				)}
			>
				<span className="text-sm tabular-nums text-gray-500">
					{isActive ? <Play className="h-3.5 w-3.5 text-[#3b82f6]" /> : positionLabel}
				</span>
				<div className="min-w-0">
					<p className="truncate text-sm text-gray-100">{track.title}</p>
					{showArtist ? (
						<p className="truncate text-xs text-gray-500">{track.artist}</p>
					) : null}
				</div>
				<span className="text-sm tabular-nums text-gray-400">
					{formatTime(track.duration)}
				</span>
				<a
					href={getDownloadUrl(track.id)}
					download
					className="p-1 text-gray-500 transition-colors hover:text-white"
					onClick={(event) => event.stopPropagation()}
					title="Download track"
				>
					<Download className="h-4 w-4" />
				</a>
			</button>
		);
	};

	const renderAlbum = (album: AlbumResource) => {
		const cover = getCoverUrl(album.coverUrl || album.coverArt);
		return (
			<section className="space-y-6">
				<header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
					<div className="flex flex-col gap-5 sm:flex-row sm:items-end">
						{renderCover(cover)}
						<div>
							<p className="text-xs uppercase tracking-wide text-[#3b82f6]">
								Shared album
							</p>
							<h1 className="mt-2 text-3xl font-bold leading-tight">
								{album.title}
							</h1>
							<p className="mt-2 text-gray-300">{album.artist.name}</p>
							<p className="mt-2 text-sm text-gray-500">
								{trackQueue.length} tracks
							</p>
						</div>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<button
							type="button"
							onClick={handleDownloadAll}
							className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
						>
							<Download className="h-4 w-4" />
							Download All
						</button>
					</div>
				</header>
				<div className="overflow-hidden rounded-xl border border-[#262626]">
					{trackQueue.map((track, index) =>
						renderTrackRow(track, String(album.tracks[index]?.trackNo ?? index + 1), index, trackQueue.length, false),
					)}
				</div>
			</section>
		);
	};

	const renderTrack = (track: TrackResource) => {
		const playable = trackQueue[0] ?? null;
		const cover = getCoverUrl(track.album.coverUrl || track.album.coverArt);
		return (
			<section className="space-y-6">
				<header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
					<div className="flex flex-col gap-5 sm:flex-row sm:items-end">
						{renderCover(cover)}
						<div>
							<p className="text-xs uppercase tracking-wide text-[#3b82f6]">
								Shared track
							</p>
							<h1 className="mt-2 text-3xl font-bold leading-tight">{track.title}</h1>
							<p className="mt-2 text-gray-300">{track.album.artist.name}</p>
							<p className="mt-1 text-sm text-gray-500">{track.album.title}</p>
							<div className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-[#262626] px-2.5 py-1 text-sm text-gray-300">
								<Clock className="h-4 w-4 text-[#3b82f6]" />
								{formatTime(track.duration)}
							</div>
						</div>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						{playable ? (
							<button
								type="button"
								onClick={() => playTrack(playable)}
								className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
							>
								{currentTrack?.id === playable.id && isPlaying ? (
									<Pause className="h-4 w-4" />
								) : (
									<Play className="h-4 w-4" />
								)}
								{currentTrack?.id === playable.id && isPlaying ? "Pause" : "Play"}
							</button>
						) : null}
						<a
							href={getDownloadUrl(track.id)}
							download
							className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
						>
							<Download className="h-4 w-4" />
							Download
						</a>
					</div>
				</header>
			</section>
		);
	};

	const renderPlaylist = (playlist: PlaylistResource) => {
		const exportName = sanitizeFilename(playlist.name);
		return (
			<section className="space-y-6">
				<header className="space-y-4">
					<div className="inline-flex items-center gap-2 rounded-md border border-[#262626] px-2.5 py-1 text-xs uppercase tracking-wide text-[#3b82f6]">
						<ListMusic className="h-3.5 w-3.5" />
						Shared playlist
					</div>
					<h1 className="text-3xl font-bold leading-tight">{playlist.name}</h1>
					<p className="text-gray-300">by {playlist.user?.username || "Unknown user"}</p>
					<p className="text-sm text-gray-500">
						{trackQueue.length} items
					</p>
					<div className="flex flex-wrap items-center gap-2">
						<button
							type="button"
							onClick={handleDownloadAll}
							className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
						>
							<Download className="h-4 w-4" />
							Download All
						</button>
						<button
							type="button"
							onClick={() =>
								downloadBlob(
									buildJsonExport(playlist.name, trackQueue),
									`${exportName}.json`,
									"application/json",
								)
							}
							className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
						>
							<FileJson className="h-4 w-4" />
							Export JSON
						</button>
						<button
							type="button"
							onClick={() =>
								downloadBlob(
									buildM3uExport(playlist.name, trackQueue),
									`${exportName}.m3u`,
									"audio/x-mpegurl",
								)
							}
							className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
						>
							<FileText className="h-4 w-4" />
							Export M3U
						</button>
					</div>
				</header>
				<div className="overflow-hidden rounded-xl border border-[#262626]">
					{playlistFilteredItems.map((_, index) => {
						const track = trackQueue[index];
						if (!track) {
							return null;
						}
						return renderTrackRow(track, String(index + 1), index, trackQueue.length, true);
					})}
				</div>
			</section>
		);
	};

	const progressPercent = duration > 0 ? Math.min(100, (progress / duration) * 100) : 0;

	return (
		<>
			<main
				className={cn(
					"min-h-screen bg-[#0a0a0a] px-4 py-10 text-white",
					currentTrack ? "pb-28" : undefined,
				)}
			>
				<div className="mx-auto w-full max-w-4xl rounded-xl border border-white/10 bg-[#111111]/60 p-6 sm:p-8">
					{data.resourceType === "album" && renderAlbum(data.resource as AlbumResource)}
					{data.resourceType === "track" && (
						<div className="space-y-4">
							<div className="inline-flex items-center gap-2 text-xs uppercase tracking-wide text-gray-500">
								<Disc3 className="h-3.5 w-3.5 text-[#3b82f6]" />
								Track details
							</div>
							{renderTrack(data.resource as TrackResource)}
						</div>
					)}
					{data.resourceType === "playlist" &&
						renderPlaylist(data.resource as PlaylistResource)}
					<p className="mt-10 text-center text-xs text-gray-600">soundspan™</p>
				</div>
			</main>

			{currentTrack ? (
				<div className="fixed inset-x-0 bottom-0 z-50 border-t border-[#262626] bg-[#111111]">
					<div className="mx-auto flex w-full max-w-7xl items-center gap-4 px-4 py-3">
						<div className="flex min-w-0 flex-1 items-center gap-3">
							<div className="h-12 w-12 shrink-0 overflow-hidden rounded-md border border-[#262626] bg-[#0a0a0a]">
								{currentTrack.coverUrl ? (
									<img
										src={currentTrack.coverUrl}
										alt={currentTrack.title}
										className="h-full w-full object-cover"
									/>
								) : (
									<div className="flex h-full w-full items-center justify-center text-gray-500">
										<Music className="h-5 w-5" />
									</div>
								)}
							</div>
							<div className="min-w-0">
								<p className="truncate text-sm font-medium text-white">{currentTrack.title}</p>
								<p className="truncate text-xs text-gray-400">{currentTrack.artist}</p>
							</div>
						</div>

						<div className="flex shrink-0 items-center gap-2">
							<button
								type="button"
								onClick={handlePrev}
								disabled={!hasPrev && progress <= 3}
								className="rounded-md p-2 text-gray-300 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
								title="Previous"
							>
								<SkipBack className="h-4 w-4" />
							</button>
							<button
								type="button"
								onClick={handlePlayPause}
								className="rounded-full bg-white p-2 text-black transition-opacity hover:opacity-90"
								title={isPlaying ? "Pause" : "Play"}
							>
								{isPlaying ? (
									<Pause className="h-5 w-5" />
								) : (
									<Play className="h-5 w-5" />
								)}
							</button>
							<button
								type="button"
								onClick={handleNext}
								disabled={!hasNext}
								className="rounded-md p-2 text-gray-300 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
								title="Next"
							>
								<SkipForward className="h-4 w-4" />
							</button>
						</div>

						<div className="flex min-w-0 flex-[1.4] items-center gap-3">
						<div
							role="slider"
							aria-label="Playback progress"
							tabIndex={0}
							aria-valuemin={0}
							aria-valuemax={Math.max(duration, currentTrack.duration)}
							aria-valuenow={progress}
							onClick={handleSeek}
							onKeyDown={(event) => {
								const audio = audioRef.current;
								if (!audio) {
									return;
								}
								if (event.key === "ArrowRight") {
									event.preventDefault();
									audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
									setProgress(audio.currentTime);
								}
								if (event.key === "ArrowLeft") {
									event.preventDefault();
									audio.currentTime = Math.max(0, audio.currentTime - 5);
									setProgress(audio.currentTime);
								}
							}}
							className="h-2 w-full cursor-pointer rounded-full bg-white/20"
						>
								<div
									className="h-full rounded-full bg-[#3b82f6]"
									style={{ width: `${progressPercent}%` }}
								/>
							</div>
							<span className="whitespace-nowrap text-xs tabular-nums text-gray-400">
								{formatTime(progress)} / {formatTime(duration || currentTrack.duration)}
							</span>
						</div>

						<div className="flex shrink-0 items-center gap-2">
							<button
								type="button"
								onClick={toggleMute}
								className="rounded-md p-1.5 text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
								title={isMuted ? "Unmute" : "Mute"}
							>
								{isMuted || volume === 0 ? (
									<VolumeX className="h-4 w-4" />
								) : (
									<Volume2 className="h-4 w-4" />
								)}
							</button>
							<input
								type="range"
								min="0"
								max="1"
								step="0.01"
								value={isMuted ? 0 : volume}
								onChange={handleVolumeChange}
								className="h-1.5 w-24 cursor-pointer accent-[#3b82f6]"
								aria-label="Volume"
							/>
						</div>
					</div>
				</div>
			) : null}

			<audio
				ref={audioRef}
				src={currentTrack ? getStreamUrl(currentTrack.id) : undefined}
				onTimeUpdate={() => setProgress(audioRef.current?.currentTime ?? 0)}
				onLoadedMetadata={() => setDuration(audioRef.current?.duration ?? 0)}
				onEnded={handleNext}
				onPlay={() => setIsPlaying(true)}
				onPause={() => setIsPlaying(false)}
			>
				<track kind="captions" srcLang="en" label="Music" />
			</audio>
		</>
	);
}
