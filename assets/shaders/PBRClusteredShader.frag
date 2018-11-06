#version 460 core
//Naming scheme clarification
// mS = model Space
// vS = view Space
// wS = world Space
// tS = tangent Space

layout(early_fragment_tests) in;

out vec4 FragColor;

in VS_OUT{
    vec3 fragPos_wS;
    vec2 texCoords;
    vec4 fragPos_lS;
    vec3 T;
    vec3 B;
    vec3 N;
    mat3 TBN;
} fs_in;

//Dir light uniform
struct DirLight{
    vec3 direction;
    vec3 color;
};
uniform DirLight dirLight;

//Textures to sample from
uniform sampler2D shadowMap;
uniform sampler2D diffuse1;
uniform sampler2D specular1;
uniform sampler2D normal1;
uniform sampler2D metallic1;

//Misc Uniforms
uniform vec3 cameraPos_wS;

//To be changed in the future..
#define SHADOW_CASTING_POINT_LIGHTS 4
#define M_PI 3.1415926535897932384626433832795
//PointLight buffer in GPU
struct PointLight{
    vec4 position;
    vec4 color;
    bool enabled;
    float intensity;
    float range;
};

struct LightGrid{
    uint offset;
    uint count;
};

layout (std430, binding = 2) buffer screenToView{
    mat4 inverseProjection;
    uvec4 tileSizes;
    uvec2 screenDimensions;
    float scale;
    float bias;
};
layout (std430, binding = 3) buffer lightSSBO{
    PointLight pointLight[];
};

layout (std430, binding = 4) buffer lightIndexSSBO{
    uint globalLightIndexList[];
};

layout (std430, binding = 5) buffer lightGridSSBO{
    LightGrid lightGrid[];
};

//TODO:: Probably should be a buffer...
vec3 sampleOffsetDirections[20] = vec3[]
(
   vec3( 1,  1,  1), vec3( 1, -1,  1), vec3(-1, -1,  1), vec3(-1,  1,  1), 
   vec3( 1,  1, -1), vec3( 1, -1, -1), vec3(-1, -1, -1), vec3(-1,  1, -1),
   vec3( 1,  1,  0), vec3( 1, -1,  0), vec3(-1, -1,  0), vec3(-1,  1,  0),
   vec3( 1,  0,  1), vec3(-1,  0,  1), vec3( 1,  0, -1), vec3(-1,  0, -1),
   vec3( 0,  1,  1), vec3( 0, -1,  1), vec3( 0, -1, -1), vec3( 0,  1, -1)
);

//TODO: change far plane to a different location
uniform samplerCube depthMaps[SHADOW_CASTING_POINT_LIGHTS];
uniform float far_plane;
uniform float zFar;
uniform float zNear;

//Function prototypes
vec3 calcDirLight(DirLight light, vec3 normal, vec3 viewDir, vec3 albedo, float rough, float metal, float shadow, vec3 F0);
float calcDirShadow(vec4 fragPosLightSpace);
vec3 calcPointLight(uint index, vec3 normal, vec3 fragPos, vec3 viewDir, vec3 albedo, float rough, float metal, vec3 F0,  float viewDistance);
float calcPointLightShadows(samplerCube depthMap, vec3 fragPos, float viewDistance);
float linearDepth(float depthSample);
// uint  findSlice(float depth);

//PBR Functions
vec3 fresnelSchlick(float cosTheta, vec3 F0);
float distributionGGX(vec3 N, vec3 H, float rough);
float geometrySchlickGGX(float nDotV, float rough);
float geometrySmith(float nDotV, float nDotL, float rough);

void main(){
    //Texture Reads
    vec3 albedo     =  texture(diffuse1, fs_in.texCoords).rgb;
    vec3 normal     =  normalize(2.0 * texture(normal1, fs_in.texCoords).rgb - 1.0);
    float roughness =  texture(specular1, fs_in.texCoords).r;
    float metallic  =  texture(metallic1, fs_in.texCoords).r;

    //Components common to all light types
    mat3 TBN  = mat3(fs_in.T, fs_in.B, fs_in.N);
    vec3 norm = normalize(TBN * normal ); //going -1 to 1
    vec3 viewDir     = normalize(cameraPos_wS - fs_in.fragPos_wS);

    //Correcting zero incidence reflection
    vec3 F0   = vec3(0.04);
    F0 = mix(F0, albedo, metallic);

    //Locating which cluster you are a part of
    uint zTile     = uint(max(log2(linearDepth(gl_FragCoord.z)) * scale + bias, 0));
    uvec3 tiles    = uvec3( uvec2( gl_FragCoord.xy / tileSizes[3] ), zTile);
    uint tileIndex = tiles.x +
                     tileSizes.x * tiles.y +
                     (tileSizes.x * tileSizes.y) * tiles.z;  

    //Solving outgoing reflectance of fragment
    vec3 radianceOut = vec3(0.0);

    // shadow calcs
    float shadow = calcDirShadow(fs_in.fragPos_lS);
    float viewDistance = length(cameraPos_wS - fs_in.fragPos_wS);

    //Directional light 
    radianceOut = calcDirLight(dirLight, norm, viewDir, albedo, roughness, metallic, shadow, F0) ;

    // Point lights
    uint lightCount       = lightGrid[tileIndex].count;
    uint lightIndexOffset = lightGrid[tileIndex].offset;

    for(uint i = 0; i < lightCount; i++){
        uint bigAssLightVectorIndex = globalLightIndexList[lightIndexOffset + i];
        radianceOut += calcPointLight(bigAssLightVectorIndex, norm, fs_in.fragPos_wS, viewDir, albedo, roughness, metallic, F0, viewDistance);
    }

    //Ambient term for the fragment    
    vec3 ambient = vec3(0.01)* albedo;
    radianceOut += ambient;

    FragColor = vec4(radianceOut, 1.0);
}

vec3 calcDirLight(DirLight light, vec3 normal, vec3 viewDir, vec3 albedo, float rough, float metal, float shadow, vec3 F0){
    //Variables common to BRDFs
    vec3 lightDir = normalize(-light.direction);
    vec3 halfway  = normalize(lightDir + viewDir);
    float nDotV = max(dot(normal, viewDir), 0.0);
    float nDotL = max(dot(normal, lightDir), 0.0);
    vec3 radianceIn = dirLight.color;

    //Cook-Torrance BRDF
    float NDF = distributionGGX(normal, halfway, rough);
    float G   = geometrySmith(nDotV, nDotL, rough);
    vec3  F   = fresnelSchlick(max(dot(halfway,viewDir), 0.0), F0);

    //Finding specular and diffuse component
    vec3 kS = F;
    vec3 kD = vec3(1.0) - kS;
    kD *= 1.0 - metal;

    vec3 numerator = NDF * G * F;
    float denominator = 4.0 * nDotV * nDotL;
    vec3 specular = numerator / max (denominator, 0.0001);

    vec3 radiance = (kD * (albedo / M_PI) + specular ) * radianceIn * nDotL;
    radiance *= (1.0 - shadow);

    return radiance;
}

float calcDirShadow(vec4 fragPosLightSpace){
    vec3 projCoords = fragPosLightSpace.xyz / fragPosLightSpace.w;
    projCoords = projCoords * 0.5 + 0.5;
    float bias = 0.0;
    int   samples = 9;
    float shadow = 0.0;

    vec2 texelSize = 1.0 / textureSize(shadowMap, 0);

    for(int i = 0; i < samples; ++i){
        float pcfDepth = texture(shadowMap, projCoords.xy + sampleOffsetDirections[i].xy * texelSize).r;
        shadow += projCoords.z - bias > pcfDepth ? 0.111111 : 0.0;
    }

    return shadow;
}

vec3 calcPointLight(uint index, vec3 normal, vec3 fragPos,
                    vec3 viewDir, vec3 albedo, float rough,
                    float metal, vec3 F0,  float viewDistance){
    //Point light basics
    vec3 position = pointLight[index].position.xyz;
    vec3 color    = 100.0 * pointLight[index].color.rgb;
    float radius  = pointLight[index].range;

    //Stuff common to the BRDF subfunctions 
    vec3 lightDir = normalize(position - fragPos);
    vec3 halfway  = normalize(lightDir + viewDir);
    float nDotV = max(dot(normal, viewDir), 0.0);
    float nDotL = max(dot(normal, lightDir), 0.0);

    //Attenuation calculation that is applied to all
    float distance    = length(position - fragPos);
    float attenuation = pow(clamp(1 - pow((distance / radius), 4.0), 0.0, 1.0), 2.0)/(1.0  + (distance * distance) );
    vec3 radianceIn   = color * attenuation;

    //Cook-Torrance BRDF
    float NDF = distributionGGX(normal, halfway, rough);
    float G   = geometrySmith(nDotV, nDotL, rough);
    vec3  F   = fresnelSchlick(max(dot(halfway,viewDir), 0.0), F0);

    //Finding specular and diffuse component
    vec3 kS = F;
    vec3 kD = vec3(1.0) - kS;
    kD *= 1.0 - metal;

    vec3 numerator = NDF * G * F;
    float denominator = 4.0 * nDotV * nDotL;
    vec3 specular = numerator / max (denominator, 0.0001);

    vec3 radiance = (kD * (albedo / M_PI) + specular ) * radianceIn * nDotL;

    //shadow stuff
    vec3 fragToLight = fragPos - position;
    float shadow = calcPointLightShadows(depthMaps[index], fragToLight, viewDistance);
    
    radiance *= (1.0 - shadow);

    return radiance;
}


float calcPointLightShadows(samplerCube depthMap, vec3 fragToLight, float viewDistance){
    float shadow      = 0.0;
    float bias        = 0.0;
    int   samples     = 8;
    float fraction    = 1.0/float(samples);
    float diskRadius  = (1.0 + (viewDistance / far_plane)) / 25.0;
    float currentDepth = (length(fragToLight) - bias);

    for(int i = 0; i < samples; ++i){
        float closestDepth = texture(depthMap, fragToLight + sampleOffsetDirections[i], diskRadius).r;
        closestDepth *= far_plane;
        if(currentDepth > closestDepth){
            shadow += fraction;
        }
    }

    return shadow;
}

float linearDepth(float depthSample){
    float depthRange = 2.0 * depthSample - 1.0;
    // Near... Far... wherever you are...
    float linear = 2.0 * zNear * zFar / (zFar + zNear - depthRange * (zFar - zNear));
    // float linear = 2.0; 
    return linear;
}


// PBR functions
vec3 fresnelSchlick(float cosTheta, vec3 F0){
    float val = 1.0 - cosTheta;
    return F0 + (1.0 - F0) * (val*val*val*val*val); //Faster than pow
}

float distributionGGX(vec3 N, vec3 H, float rough){
    float a  = rough * rough;
    float a2 = a * a;

    float nDotH  = max(dot(N, H), 0.0);
    float nDotH2 = nDotH * nDotH;

    float num = a2; 
    float denom = (nDotH2 * (a2 - 1.0) + 1.0);
    denom = 1 / (M_PI * denom * denom);

    return num * denom;
}

float geometrySchlickGGX(float nDotV, float rough){
    float r = (rough + 1.0);
    float k = r*r / 8.0;

    float num = nDotV;
    float denom = 1 / (nDotV * (1.0 - k) + k);

    return num * denom;
}

float geometrySmith(float nDotV, float nDotL, float rough){
    float ggx2  = geometrySchlickGGX(nDotV, rough);
    float ggx1  = geometrySchlickGGX(nDotL, rough);

    return ggx1 * ggx2;
}