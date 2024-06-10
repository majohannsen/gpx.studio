import { get, writable } from "svelte/store";
import { ListFileItem, ListItem, ListRootItem, ListTrackItem, ListTrackSegmentItem, ListWaypointItem, type ListLevel, sortItems, ListWaypointsItem } from "./FileList";
import { fileObservers, settings } from "$lib/db";

export class SelectionTreeType {
    item: ListItem;
    selected: boolean;
    children: {
        [key: string | number]: SelectionTreeType
    };
    size: number = 0;

    constructor(item: ListItem) {
        this.item = item;
        this.selected = false;
        this.children = {};
    }

    clear() {
        this.selected = false;
        for (let key in this.children) {
            this.children[key].clear();
        }
        this.size = 0;
    }

    _setOrToggle(item: ListItem, value?: boolean) {
        if (item.level === this.item.level) {
            let newSelected = value === undefined ? !this.selected : value;
            if (this.selected !== newSelected) {
                this.selected = newSelected;
                this.size += this.selected ? 1 : -1;
            }
        } else {
            let id = item.getIdAtLevel(this.item.level);
            if (id !== undefined) {
                if (!this.children.hasOwnProperty(id)) {
                    this.children[id] = new SelectionTreeType(this.item.extend(id));
                }
                this.size -= this.children[id].size;
                this.children[id]._setOrToggle(item, value);
                this.size += this.children[id].size;
            }
        }
    }

    set(item: ListItem, value: boolean) {
        this._setOrToggle(item, value);
    }

    toggle(item: ListItem) {
        this._setOrToggle(item);
    }

    has(item: ListItem): boolean {
        if (item.level === this.item.level) {
            return this.selected;
        } else {
            let id = item.getIdAtLevel(this.item.level);
            if (id !== undefined) {
                if (this.children.hasOwnProperty(id)) {
                    return this.children[id].has(item);
                }
            }
        }
        return false;
    }

    hasAnyParent(item: ListItem, self: boolean = true): boolean {
        if (this.selected && this.item.level <= item.level && (self || this.item.level < item.level)) {
            return this.selected;
        }
        let id = item.getIdAtLevel(this.item.level);
        if (id !== undefined) {
            if (this.children.hasOwnProperty(id)) {
                return this.children[id].hasAnyParent(item, self);
            }
        }
        return false;
    }

    hasAnyChildren(item: ListItem, self: boolean = true, ignoreIds?: (string | number)[]): boolean {
        if (this.selected && this.item.level >= item.level && (self || this.item.level > item.level)) {
            return this.selected;
        }
        let id = item.getIdAtLevel(this.item.level);
        if (id !== undefined) {
            if (ignoreIds === undefined || ignoreIds.indexOf(id) === -1) {
                if (this.children.hasOwnProperty(id)) {
                    return this.children[id].hasAnyChildren(item, self, ignoreIds);
                }
            }
        } else {
            for (let key in this.children) {
                if (ignoreIds === undefined || ignoreIds.indexOf(key) === -1) {
                    if (this.children[key].hasAnyChildren(item, self, ignoreIds)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    getSelected(selection?: ListItem[]): ListItem[] {
        if (selection === undefined) {
            selection = [];
        }
        if (this.selected) {
            selection.push(this.item);
        }
        for (let key in this.children) {
            this.children[key].getSelected(selection);
        }
        return selection;
    }

    forEach(callback: (item: ListItem) => void) {
        if (this.selected) {
            callback(this.item);
        }
        for (let key in this.children) {
            this.children[key].forEach(callback);
        }
    }

    getChild(id: string | number): SelectionTreeType | undefined {
        return this.children[id];
    }

    deleteChild(id: string | number) {
        if (this.children.hasOwnProperty(id)) {
            this.size -= this.children[id].size;
            delete this.children[id];
        }
    }
};

export const selection = writable<SelectionTreeType>(new SelectionTreeType(new ListRootItem()));

export function selectItem(item: ListItem) {
    selection.update(($selection) => {
        $selection.clear();
        $selection.set(item, true);
        return $selection;
    });
}

export function selectFile(fileId: string) {
    selectItem(new ListFileItem(fileId));
}

export function addSelectItem(item: ListItem) {
    selection.update(($selection) => {
        $selection.toggle(item);
        return $selection;
    });
}

export function addSelectFile(fileId: string) {
    addSelectItem(new ListFileItem(fileId));
}

export function selectAll() {
    selection.update(($selection) => {
        let item: ListItem = new ListRootItem();
        $selection.forEach((i) => {
            item = i;
        });

        if (item instanceof ListRootItem || item instanceof ListFileItem) {
            $selection.clear();
            get(fileObservers).forEach((_file, fileId) => {
                $selection.set(new ListFileItem(fileId), true);
            });
        } else if (item instanceof ListTrackItem) {
            let fileStore = get(fileObservers).get(item.getFileId());
            if (fileStore) {
                get(fileStore)?.file.trk.forEach((_track, trackId) => {
                    $selection.set(new ListTrackItem(item.getFileId(), trackId), true);
                });
            }
        } else if (item instanceof ListTrackSegmentItem) {
            let fileStore = get(fileObservers).get(item.getFileId());
            if (fileStore) {
                get(fileStore)?.file.trk[item.getTrackIndex()].trkseg.forEach((_segment, segmentId) => {
                    $selection.set(new ListTrackSegmentItem(item.getFileId(), item.getTrackIndex(), segmentId), true);
                });
            }
        } else if (item instanceof ListWaypointItem) {
            let fileStore = get(fileObservers).get(item.getFileId());
            if (fileStore) {
                get(fileStore)?.file.wpt.forEach((_waypoint, waypointId) => {
                    $selection.set(new ListWaypointItem(item.getFileId(), waypointId), true);
                });
            }
        }

        return $selection;
    });
}

export function applyToOrderedSelectedItemsFromFile(callback: (fileId: string, level: ListLevel | undefined, items: ListItem[]) => void, reverse: boolean = true) {
    get(settings.fileOrder).forEach((fileId) => {
        let level: ListLevel | undefined = undefined;
        let items: ListItem[] = [];
        get(selection).forEach((item) => {
            if (item.getFileId() === fileId) {
                level = item.level;
                if (item instanceof ListFileItem || item instanceof ListTrackItem || item instanceof ListTrackSegmentItem || item instanceof ListWaypointsItem || item instanceof ListWaypointItem) {
                    items.push(item);
                }
            }
        });

        if (items.length > 0) {
            sortItems(items, reverse);
            callback(fileId, level, items);
        }
    });
}