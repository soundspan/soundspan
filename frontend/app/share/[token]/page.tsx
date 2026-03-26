"use client";

import {
	AlertCircle,
	Clock,
	Disc3,
	ListMusic,
	Loader2,
	Music,
} from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
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

/** Renders the SharePage component. */
export default function SharePage() {
	const params = useParams<{ token: string | string[] }>();
	const token = Array.isArray(params.token) ? params.token[0] : params.token;
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(false);
	const [data, setData] = useState<ShareResponse | null>(null);

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

	if (loading) {
		return (
			<main className="min-h-screen bg-[#0a0a0a] text-white flex items-center justify-center px-4">
				<div className="flex items-center gap-3 text-gray-300">
					<Loader2 className="h-5 w-5 animate-spin text-[#3b82f6]" />
					<span>Loading shared link...</span>
				</div>
			</main>
		);
	}

	if (error || !data) {
		return (
			<main className="min-h-screen bg-[#0a0a0a] text-white flex items-center justify-center px-4">
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

	const renderCover = (cover?: string | null) => (
		<div className="h-40 w-40 overflow-hidden rounded-xl border border-[#262626] bg-[#0a0a0a] shrink-0">
		{cover ? (
			<img src={cover} alt="Cover art" className="h-full w-full object-cover" />
		) : (
				<div className="flex h-full w-full items-center justify-center text-gray-500">
					<Music className="h-14 w-14" />
				</div>
			)}
		</div>
	);

	const renderAlbum = (album: AlbumResource) => {
		const cover = album.coverUrl || album.coverArt || null;
		return (
			<section className="space-y-6">
				<header className="flex flex-col gap-5 sm:flex-row sm:items-end">
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
							{album.tracks.length} tracks
						</p>
					</div>
				</header>
				<div className="rounded-xl border border-[#262626] overflow-hidden">
					{album.tracks.map((track, index) => (
						<div
							key={track.id}
							className={cn(
								"grid grid-cols-[64px_1fr_auto] items-center gap-3 px-4 py-3",
								index !== album.tracks.length - 1 &&
									"border-b border-[#262626]",
							)}
						>
							<span className="text-sm text-gray-500 tabular-nums">
								{track.trackNo}
							</span>
							<span className="truncate text-sm text-gray-100">
								{track.title}
							</span>
							<span className="text-sm text-gray-400 tabular-nums">
								{formatTime(track.duration)}
							</span>
						</div>
					))}
				</div>
			</section>
		);
	};

	const renderTrack = (track: TrackResource) => {
		const cover = track.album.coverUrl || track.album.coverArt || null;
		return (
			<section className="space-y-6">
				<header className="flex flex-col gap-5 sm:flex-row sm:items-end">
					{renderCover(cover)}
					<div>
						<p className="text-xs uppercase tracking-wide text-[#3b82f6]">
							Shared track
						</p>
						<h1 className="mt-2 text-3xl font-bold leading-tight">
							{track.title}
						</h1>
						<p className="mt-2 text-gray-300">{track.album.artist.name}</p>
						<p className="mt-1 text-sm text-gray-500">{track.album.title}</p>
						<div className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-[#262626] px-2.5 py-1 text-sm text-gray-300">
							<Clock className="h-4 w-4 text-[#3b82f6]" />
							{formatTime(track.duration)}
						</div>
					</div>
				</header>
			</section>
		);
	};

	const renderPlaylist = (playlist: PlaylistResource) => {
		const sortedItems = [...playlist.items].sort((a, b) => a.sort - b.sort);
		return (
			<section className="space-y-6">
				<header>
					<div className="inline-flex items-center gap-2 rounded-md border border-[#262626] px-2.5 py-1 text-xs uppercase tracking-wide text-[#3b82f6]">
						<ListMusic className="h-3.5 w-3.5" />
						Shared playlist
					</div>
					<h1 className="mt-3 text-3xl font-bold leading-tight">
						{playlist.name}
					</h1>
					<p className="mt-2 text-gray-300">
						by {playlist.user?.username || "Unknown user"}
					</p>
					<p className="mt-2 text-sm text-gray-500">
						{sortedItems.length} items
					</p>
				</header>
				<div className="rounded-xl border border-[#262626] overflow-hidden">
					{sortedItems.map((item, index) => {
						const title = item.track?.title || "Unavailable track";
						const artist = item.track?.album.artist.name || "Unknown artist";
						const duration = item.track?.duration ?? 0;

						return (
							<div
								key={item.id}
								className={cn(
									"grid grid-cols-[40px_1fr_auto] items-center gap-3 px-4 py-3",
									index !== sortedItems.length - 1 &&
										"border-b border-[#262626]",
								)}
							>
								<span className="text-sm text-gray-500 tabular-nums">
									{index + 1}
								</span>
								<div className="min-w-0">
									<p className="truncate text-sm text-gray-100">{title}</p>
									<p className="truncate text-xs text-gray-500">{artist}</p>
								</div>
								<span className="text-sm text-gray-400 tabular-nums">
									{formatTime(duration)}
								</span>
							</div>
						);
					})}
				</div>
			</section>
		);
	};

	return (
		<main className="min-h-screen bg-[#0a0a0a] text-white px-4 py-10">
			<div className="mx-auto w-full max-w-2xl rounded-xl border border-white/10 bg-[#111111]/60 p-6 sm:p-8">
				{data.resourceType === "album" &&
					renderAlbum(data.resource as AlbumResource)}
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
	);
}
