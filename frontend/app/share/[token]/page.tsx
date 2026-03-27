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
import { api } from "@/lib/api";

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
			const nextVolume = Number(event.target.value) / 100;
			setVolume(nextVolume);
			setIsMuted(nextVolume === 0);
		},
		[],
	);

	const [showVolumePopup, setShowVolumePopup] = useState(false);
	const volumePopupRef = useRef<HTMLDivElement>(null);
	const volumeHoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const handleVolumeMouseEnter = useCallback(() => {
		if (volumeHoverTimeoutRef.current) {
			clearTimeout(volumeHoverTimeoutRef.current);
			volumeHoverTimeoutRef.current = null;
		}
		setShowVolumePopup(true);
	}, []);

	const handleVolumeMouseLeave = useCallback(() => {
		volumeHoverTimeoutRef.current = setTimeout(() => {
			setShowVolumePopup(false);
		}, 300);
	}, []);

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
				const json = (await api.getSharedResource(token)) as ShareResponse;
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
					currentTrack ? "pb-24" : undefined,
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
				<div className="fixed inset-x-0 bottom-0 z-50 h-24 border-t border-white/[0.08] bg-black">
					<div className="absolute inset-x-0 top-0 h-1 bg-white/20">
						<div
							className="h-full bg-white/70 transition-none"
							style={{ width: `${progressPercent}%` }}
						/>
						<input
							type="range"
							min={0}
							max={Math.max(duration, currentTrack.duration) || 100}
							step={0.1}
							value={progress}
							onChange={(event) => {
								const audio = audioRef.current;
								if (!audio) return;
								const seekTime = Number(event.target.value);
								audio.currentTime = seekTime;
								setProgress(seekTime);
							}}
							aria-label="Playback progress"
							className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
						/>
					</div>

					<div className="pointer-events-none absolute left-0 right-0 top-1 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

					<div className="grid h-full grid-cols-[1fr_auto_1fr] items-center px-6 pt-1">

						<div className="flex min-w-0 items-center gap-3 mr-4">
							<div className="relative h-14 w-14 shrink-0">
								<div className="relative h-full w-full overflow-hidden rounded-lg bg-gradient-to-br from-[#2a2a2a] to-[#1a1a1a] shadow-lg flex items-center justify-center">
									{currentTrack.coverUrl ? (
										<img
											src={currentTrack.coverUrl}
											alt={currentTrack.title}
											className="h-full w-full object-cover"
										/>
									) : (
										<Music className="h-6 w-6 text-gray-500" />
									)}
								</div>
							</div>
							<div className="min-w-0 flex-1">
								<p className="truncate text-sm font-semibold text-white">{currentTrack.title}</p>
								<p className="truncate text-xs text-gray-400">{currentTrack.artist}</p>
							</div>
						</div>

						<div className="flex items-center gap-6" role="group" aria-label="Playback controls">
							<button
								type="button"
								onClick={handlePrev}
								disabled={!hasPrev && progress <= 3}
								className="text-gray-400 transition-all duration-200 hover:scale-110 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:scale-100"
								title="Previous"
							>
								<SkipBack className="h-6 w-6" />
							</button>
							<button
								type="button"
								onClick={handlePlayPause}
								className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-black shadow-lg shadow-white/20 transition-all duration-200 hover:scale-110 hover:shadow-white/30"
								title={isPlaying ? "Pause" : "Play"}
							>
								{isPlaying ? (
									<Pause className="h-6 w-6" />
								) : (
									<Play className="h-6 w-6 ml-0.5" />
								)}
							</button>
							<button
								type="button"
								onClick={handleNext}
								disabled={!hasNext}
								className="text-gray-400 transition-all duration-200 hover:scale-110 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:scale-100"
								title="Next"
							>
								<SkipForward className="h-6 w-6" />
							</button>
						</div>

						<div className="flex items-center justify-end ml-4 gap-4">
							<span className="whitespace-nowrap text-sm font-medium tabular-nums text-gray-300">
								{formatTime(progress)}{" / "}{formatTime(duration || currentTrack.duration)}
							</span>

							<div
								className="relative z-10 flex items-center justify-center"
								onMouseEnter={handleVolumeMouseEnter}
								onMouseLeave={handleVolumeMouseLeave}
							>
								<button
									type="button"
									onClick={toggleMute}
									className="flex h-8 w-8 items-center justify-center text-gray-400 transition-all duration-200 hover:scale-110 hover:text-white"
									aria-label={isMuted || volume === 0 ? "Unmute" : "Mute"}
									title={isMuted || volume === 0 ? "Unmute" : "Mute"}
								>
									{isMuted || volume === 0 ? (
										<VolumeX className="h-[18px] w-[18px]" />
									) : (
										<Volume2 className="h-[18px] w-[18px]" />
									)}
								</button>

								<div
									className={cn(
										"absolute bottom-full left-1/2 mb-2 -translate-x-1/2 overflow-hidden rounded-lg border border-white/10 bg-[#1a1a1a] px-1.5 py-3 shadow-xl transition-all duration-200",
										showVolumePopup ? "pointer-events-auto scale-100 opacity-100" : "pointer-events-none scale-95 opacity-0",
									)}
								>
									<div className="flex h-28 flex-col items-center gap-3">
										<div className="relative flex h-full w-3 items-center justify-center overflow-hidden">
											<input
												type="range"
												min="0"
												max="100"
												value={isMuted ? 0 : Math.round(volume * 100)}
												onChange={handleVolumeChange}
												aria-label="Volume"
												aria-valuemin={0}
												aria-valuemax={100}
												aria-valuenow={Math.round(volume * 100)}
												style={{
													background: `linear-gradient(to right, #fff ${isMuted ? 0 : volume * 100}%, rgba(255,255,255,0.15) ${isMuted ? 0 : volume * 100}%)`,
												}}
												className="absolute h-1 w-24 -rotate-90 cursor-pointer appearance-none rounded-full [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-lg [&::-webkit-slider-thumb]:shadow-white/30"
											/>
										</div>
										<span className="mt-0.5 text-[10px] tabular-nums text-gray-400">
											{Math.round(isMuted ? 0 : volume * 100)}
										</span>
									</div>
								</div>
							</div>
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
