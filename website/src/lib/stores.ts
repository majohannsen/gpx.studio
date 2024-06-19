import { writable, get, type Writable } from 'svelte/store';

import mapboxgl from 'mapbox-gl';
import { GPXFile, buildGPX, parseGPX, GPXStatistics, type Coordinates } from 'gpx';
import { tick } from 'svelte';
import { _ } from 'svelte-i18n';
import type { GPXLayer } from '$lib/components/gpx-layer/GPXLayer';
import { dbUtils, fileObservers, getFile, getStatistics, settings } from './db';
import { applyToOrderedSelectedItemsFromFile, selectFile, selection } from '$lib/components/file-list/Selection';
import { ListFileItem, ListWaypointItem, ListWaypointsItem } from '$lib/components/file-list/FileList';
import type { RoutingControls } from '$lib/components/toolbar/tools/routing/RoutingControls';
import { overlayTree, overlays, stravaHeatmapActivityIds, stravaHeatmapServers } from '$lib/assets/layers';
import { SplitType } from '$lib/components/toolbar/tools/Scissors.svelte';

export const map = writable<mapboxgl.Map | null>(null);
export const selectFiles = writable<{ [key: string]: (fileId?: string) => void }>({});

export const gpxStatistics: Writable<GPXStatistics> = writable(new GPXStatistics());
export const slicedGPXStatistics: Writable<[GPXStatistics, number, number] | undefined> = writable(undefined);

function updateGPXData() {
    let statistics = new GPXStatistics();
    applyToOrderedSelectedItemsFromFile((fileId, level, items) => {
        let stats = getStatistics(fileId);
        if (stats) {
            let first = true;
            items.forEach((item) => {
                if (!(item instanceof ListWaypointItem || item instanceof ListWaypointsItem) || first) {
                    statistics.mergeWith(stats.getStatisticsFor(item));
                    first = false;
                }
            });
        }
    }, false);
    gpxStatistics.set(statistics);
}

let unsubscribes: Map<string, () => void> = new Map();
selection.subscribe(($selection) => { // Maintain up-to-date statistics for the current selection
    updateGPXData();

    while (unsubscribes.size > 0) {
        let [fileId, unsubscribe] = unsubscribes.entries().next().value;
        unsubscribe();
        unsubscribes.delete(fileId);
    }

    $selection.forEach((item) => {
        let fileId = item.getFileId();
        if (!unsubscribes.has(fileId)) {
            let fileObserver = get(fileObservers).get(fileId);
            if (fileObserver) {
                let first = true;
                unsubscribes.set(fileId, fileObserver.subscribe(() => {
                    if (first) first = false;
                    else updateGPXData();
                }));
            }
        }
    });
});

gpxStatistics.subscribe(() => {
    slicedGPXStatistics.set(undefined);
});

const targetMapBounds = writable({
    bounds: new mapboxgl.LngLatBounds([180, 90, -180, -90]),
    initial: true
});

targetMapBounds.subscribe((bounds) => {
    if (bounds.initial) {
        return;
    }

    let currentBounds = get(map)?.getBounds();
    if (currentBounds && currentBounds.contains(bounds.bounds.getSouthEast()) && currentBounds.contains(bounds.bounds.getNorthWest())) {
        return;
    }

    get(map)?.fitBounds(bounds.bounds, {
        padding: 80,
        linear: true,
        easing: () => 1
    });
});


export function initTargetMapBounds(first: boolean) {
    let bounds = new mapboxgl.LngLatBounds([180, 90, -180, -90]);
    let mapBounds = new mapboxgl.LngLatBounds([180, 90, -180, -90]);
    if (!first) { // Some files are already loaded
        mapBounds = get(map)?.getBounds() ?? mapBounds;
        bounds.extend(mapBounds);
    }
    targetMapBounds.set({
        bounds: bounds,
        initial: true
    });
}

export function updateTargetMapBounds(bounds: {
    southWest: Coordinates,
    northEast: Coordinates
}) {
    if (bounds.southWest.lat == 90 && bounds.southWest.lon == 180 && bounds.northEast.lat == -90 && bounds.northEast.lon == -180) { // Avoid update for empty (new) files
        return;
    }

    targetMapBounds.update((target) => {
        target.bounds.extend(bounds.southWest);
        target.bounds.extend(bounds.northEast);
        target.initial = false;
        return target;
    });
}

export const gpxLayers: Map<string, GPXLayer> = new Map();
export const routingControls: Map<string, RoutingControls> = new Map();

export enum Tool {
    ROUTING,
    WAYPOINT,
    SCISSORS,
    TIME,
    MERGE,
    EXTRACT,
    REDUCE,
    CLEAN
}
export const currentTool = writable<Tool | null>(null);
export const splitAs = writable(SplitType.FILES);

export function newGPXFile() {
    const newFileName = get(_)("menu.new_filename");

    let file = new GPXFile();

    let maxNewFileNumber = 0;
    get(fileObservers).forEach((f) => {
        let file = get(f)?.file;
        if (file && file.metadata.name.startsWith(newFileName)) {
            let number = parseInt(file.metadata.name.split(' ').pop() ?? '0');
            if (!isNaN(number) && number > maxNewFileNumber) {
                maxNewFileNumber = number;
            }
        }
    });

    file.metadata.name = `${newFileName} ${maxNewFileNumber + 1}`;

    return file;
}

export function createFile() {
    let file = newGPXFile();

    dbUtils.add(file);

    selectFileWhenLoaded(file._data.id);
    currentTool.set(Tool.ROUTING);
}

export function triggerFileInput() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.gpx';
    input.multiple = true;
    input.className = 'hidden';
    input.onchange = () => {
        if (input.files) {
            loadFiles(input.files);
        }
    };
    input.click();
}

export async function loadFiles(list: FileList) {
    let files = [];
    for (let i = 0; i < list.length; i++) {
        let file = await loadFile(list[i]);
        if (file) {
            files.push(file);
        }
    }

    dbUtils.addMultiple(files);

    selectFileWhenLoaded(files[0]._data.id);
}

export async function loadFile(file: File): Promise<GPXFile | null> {
    let result = await new Promise<GPXFile | null>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
            let data = reader.result?.toString() ?? null;
            if (data) {
                let gpx = parseGPX(data);
                if (gpx.metadata === undefined) {
                    gpx.metadata = { name: file.name.split('.').slice(0, -1).join('.') };
                } else if (gpx.metadata.name === undefined) {
                    gpx.metadata['name'] = file.name.split('.').slice(0, -1).join('.');
                }
                resolve(gpx);
            } else {
                resolve(null);
            }
        };
        reader.readAsText(file);
    });
    return result;
}

export function selectFileWhenLoaded(fileId: string) {
    const unsubscribe = fileObservers.subscribe((files) => {
        if (files.has(fileId)) {
            tick().then(() => {
                selectFile(fileId);
            });
            unsubscribe();
        }
    });
}

export function exportSelectedFiles() {
    get(selection).forEach(async (item) => {
        if (item instanceof ListFileItem) {
            let file = getFile(item.getFileId());
            if (file) {
                exportFile(file);
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }
    });
}

export function exportAllFiles() {
    get(fileObservers).forEach(async (file) => {
        let f = get(file);
        if (f) {
            exportFile(f.file);
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    });
}

export function exportFile(file: GPXFile) {
    let blob = new Blob([buildGPX(file)], { type: 'application/gpx+xml' });
    let url = URL.createObjectURL(blob);
    let a = document.createElement('a');
    a.href = url;
    a.download = file.metadata.name + '.gpx';
    a.click();
    URL.revokeObjectURL(url);
}

export function toggleSelectionVisibility() {
    let files = new Set<string>();
    get(selection).forEach((item) => {
        files.add(item.getFileId());
    });
    files.forEach((fileId) => {
        let layer = gpxLayers.get(fileId);
        if (layer) {
            layer.toggleVisibility();
        }
    });
}

let stravaCookies: any = null;
function refreshStravaCookies() {
    /*
    TODO
    if (stravaCookies === null) {
        return fetch('https://s.gpx.studio')
            .then(response => {
                if (response.ok) {
                    return response.json();
                } else {
                    throw new Error('Failed to fetch Strava cookies');
                }
            })
            .then(data => {
                stravaCookies = data;
                console.log('Strava cookies:', stravaCookies);
            });
    } else {
        return Promise.resolve();
    }
    */
    return Promise.resolve();
}

export function setStravaHeatmapURLs() {
    /*refreshStravaCookies().then(() => {
        overlays.stravaHeatmapRun.tiles = [];
        overlays.stravaHeatmapTrailRun.tiles = [];
        overlays.stravaHeatmapHike.tiles = [];
        overlays.stravaHeatmapRide.tiles = [];
        overlays.stravaHeatmapGravel.tiles = [];
        overlays.stravaHeatmapMTB.tiles = [];
        overlays.stravaHeatmapWater.tiles = [];
        overlays.stravaHeatmapWinter.tiles = [];

        for (let activity of Object.keys(overlayTree.overlays.world.strava)) {
            overlays[activity].tiles = [];
            for (let server of stravaHeatmapServers) {
                overlays[activity].tiles.push(`${server}/${stravaHeatmapActivityIds[activity]}/${get(settings.stravaHeatmapColor)}/{z}/{x}/{y}@2x.png`); //?Signature=${stravaCookies['CloudFront-Signature']}&Key-Pair-Id=${stravaCookies['CloudFront-Key-Pair-Id']}&Policy=${stravaCookies['CloudFront-Policy']}`);
            }
        }
    });*/
}