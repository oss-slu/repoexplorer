type DataBlockIconProps = {
    name:
        | 'repository'
        | 'contributors'
        | 'license'
        | 'bus-factor'
        | 'stars'
        | 'forks'
        | 'downloads'
        | 'organizations'
        | 'url'
        | 'description'
        | 'email';
};

export default function DataBlockIcon({ name }: DataBlockIconProps) {
    const paths = {
        repository: (
            <>
                {/* Git branch icon */}
                <path d="M6 4v12a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4V8" />
                <circle cx="6" cy="4" r="2" />
                <circle cx="18" cy="6" r="2" />
                <circle cx="18" cy="16" r="2" />
            </>
        ),
        contributors: (
            <>
                {/* Left person's head */}
                <circle cx="5" cy="7" r="3" fill="currentColor" stroke="none" />

                {/* Right person's head */}
                <circle cx="19" cy="7" r="3" fill="currentColor" stroke="none" />

                {/* Left person's shoulders */}
                <path
                    d="M0 18v-2a5 5 0 0 1 8-4"
                    fill="currentColor"
                    stroke="none"
                />

                {/* Right person's shoulders */}
                <path
                    d="M24 18v-2a5 5 0 0 0-8-4"
                    fill="currentColor"
                    stroke="none"
                />

                {/* Center person's head */}
                <circle cx="12" cy="11" r="3.5" fill="currentColor" stroke="none" />

                {/* Center person's shoulders */}
                <path
                    d="M5 22v-2a7 7 0 0 1 14 0v2z"
                    fill="currentColor"
                    stroke="none"
                />
            </>
        ),
        license: (
            <>
                {/* ID card outline */}
                <rect x="2" y="3" width="20" height="18" rx="2" />

                {/* Top header strip */}
                <path d="M2 8h20" />

                {/* Person's head */}
                <circle cx="8" cy="13" r="2.5" fill="currentColor" stroke="none" />

                {/* Person's shoulders */}
                <path
                    d="M3.5 19a4.5 4.5 0 0 1 9 0"
                    fill="currentColor"
                    stroke="none"
                />

                {/* ID information lines */}
                <path d="M14 12h5M14 15h5M14 18h3" />
            </>
        ),
        'bus-factor': (
            <>
                {/* Bus body */}
                <rect x="3" y="2" width="18" height="18" rx="4" />

                {/* Large front windshield */}
                <rect x="5" y="6" width="14" height="8" rx="1" />

                {/* Windshield divider */}
                <path d="M12 6v8" />

                {/* Headlights */}
                <circle cx="7" cy="17" r="1.5" fill="currentColor" stroke="none" />
                <circle cx="17" cy="17" r="1.5" fill="currentColor" stroke="none" />

                {/* Bus wheels */}
                <path d="M6 20v2M18 20v2" strokeWidth="3" />

                {/* Destination sign */}
                <path d="M9 4h6" />
            </>
        ),
        stars: (
            <>
                {/* Filled five-pointed star */}
                <path
                    d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.3-6.2 3.3 1.2-6.8-5-4.9 6.9-1z"
                    fill="currentColor"
                    stroke="none"
                />
            </>
        ),
        forks: (
            <>
                {/* Two upper endpoints */}
                <circle cx="6" cy="4" r="2" />
                <circle cx="18" cy="4" r="2" />

                {/* Bottom endpoint */}
                <circle cx="12" cy="20" r="2" />

                {/* Fork branches */}
                <path d="M6 6v5a6 6 0 0 0 6 6M18 6v5a6 6 0 0 1-6 6v1" />
            </>
        ),
        downloads: (
            <>
                {/* Download arrow */}
                <path d="M12 2v13M6 9l6 6 6-6" strokeWidth="3" />

                {/* Download tray */}
                <path
                    d="M4 17v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"
                    strokeWidth="3"
                />
            </>
        ),
        organizations: (
            <>
                {/* Building */}
                <rect
                    x="3"
                    y="2"
                    width="18"
                    height="20"
                    rx="2"
                    fill="currentColor"
                    stroke="none"
                />

                {/* Windows */}
                <rect x="6" y="5" width="4" height="4" rx="0.5" fill="white" stroke="none" />
                <rect x="14" y="5" width="4" height="4" rx="0.5" fill="white" stroke="none" />
                <rect x="6" y="12" width="4" height="4" rx="0.5" fill="white" stroke="none" />
                <rect x="14" y="12" width="4" height="4" rx="0.5" fill="white" stroke="none" />

                {/* Door */}
                <path
                    d="M10 22v-4a2 2 0 0 1 4 0v4"
                    fill="white"
                    stroke="none"
                />
            </>
        ),
        url: (
            <>
                {/* Two connected chain links */}
                <path
                    d="M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-2 2"
                    strokeWidth="3"
                />
                <path
                    d="M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l2-2"
                    strokeWidth="3"
                />
            </>
        ),
        description: (
            <>
                {/* Square outline */}
                <path
                    d="M14 4H5a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3v-7"
                    strokeWidth="3"
                />

                {/* Pencil */}
                <path
                    d="M9 15 18 6l3 3-9 9-4 1z"
                    fill="currentColor"
                    stroke="none"
                />
                <path d="m17 5 2-2a2 2 0 0 1 3 3l-2 2" strokeWidth="2" />
            </>
        ),
        email: (
            <>
                {/* Filled envelope */}
                <rect
                    x="2"
                    y="5"
                    width="20"
                    height="15"
                    rx="2"
                    fill="currentColor"
                    stroke="none"
                />

                {/* White envelope flap */}
                <path
                    d="m3 7 9 7 9-7"
                    fill="none"
                    stroke="white"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            </>
        ),
    };

    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            {paths[name]}
        </svg>
    );
}